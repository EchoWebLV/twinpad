import path from "node:path";
import { formatEther } from "viem";
import { config, redactedConfig } from "./config.js";
import { Registry } from "./registry.js";
import { Pool, sweepEth } from "./pool.js";
import { connection } from "./solana/pump.js";
import { publicClient, launchPreflight, PONS } from "./evm/pons.js";
import { fx } from "./fx.js";
import { pinFile, pinJson } from "./ipfs.js";
import { createLaunch } from "./paid.js";
import { createOperatorLaunch, shapeQuote, validateOperatorInput, buyerTotals, LOCK_ETH_EXTRA, type OperatorInput } from "./operator.js";
import { checkBundleFunding, BUNDLE_LIMITS } from "./bundle.js";
import { buildQuote, sizeFront, frontForDevBuy } from "./quote.js";
import { Recovery } from "./recover.js";
import { ETH_TX_HASH, PaymentWatcher, refundDeposit, refundFromPool } from "./payments.js";
import { Bans, type BanList } from "./bans.js";
import { Scheduler, approve, reject } from "./scheduler.js";
import { runLaunch } from "./launcher.js";
import { CoinState } from "./coin.js";
import { Poller } from "./poller.js";
import { Makers } from "./makers.js";
import { Router, RateLimit, HttpError, serve, query, type Headers as ApiHeaders } from "./api.js";
import { OPEN_STATUSES, newRetire, step, transition, publicRecord, isBanned, type LaunchRecord } from "./record.js";
import { closeCoin, Retirer } from "./retire.js";
import { rotateSolMaker } from "./rotate.js";
import { alert } from "./alerts.js";

/**
 * Launchpad entry: registry + payment watcher + scheduler + launcher + poller + makers + JSON API.
 * One process; records live on DATA_DIR (a Railway volume in production).
 */
async function main() {
  console.log("[boot] config", JSON.stringify(redactedConfig()));
  const conn = connection(config.solana.rpcUrl);
  const pub = publicClient(config.evm.rpcUrl);
  const registry = new Registry(config.server.dataDir);
  const pool = new Pool(config, conn, pub);
  console.log(`[boot] pool solana ${pool.sol.publicKey.toBase58()} robinhood ${pool.evmAddress}`);
  const bans = new Bans(path.join(config.server.dataDir, "bans.json"), { wallets: Bans.fromEnv(config.launch.bannedWallets), names: Bans.fromEnv(config.launch.bannedNames) });
  console.log(`[boot] bans ${JSON.stringify(bans.list())}`);

  // ---- live coins
  const coins = new Map<string, CoinState>();
  const poller = new Poller(conn, pub, () => [...coins.values()], config.maker.pollMs);
  const makers = new Makers(config, registry, conn, pub, new Recovery({ cfg: config, registry, pool, conn, pub }), (c) => poller.refresh(c));
  const mount = (rec: LaunchRecord) => {
    if (coins.has(rec.id)) return coins.get(rec.id)!;
    const c = new CoinState(
      config.server.dataDir, rec.id, config.maker.band,
      { pumpMint: rec.launch.pumpMint!, ponsToken: rec.launch.ponsToken!, ponsCurve: rec.launch.ponsCurve!, launchedAt: rec.launch.launchedAt, name: rec.token.name, symbol: rec.token.symbol },
      { name: rec.token.name, symbol: rec.token.symbol, image: `https://gateway.pinata.cloud/ipfs/${rec.token.imageCid}`, twitter: rec.token.twitter, website: rec.token.website, description: rec.token.description },
    );
    c.front = { sol: rec.front.sol, eth: rec.front.eth };
    c.repaid = { sol: rec.front.repaidSol, eth: rec.front.repaidEth };
    c.retiredAt = rec.front.retiredAt;
    c.entryPrice = rec.seed ? rec.seed.openingFdv / 1e9 : 0;
    if (rec.operator) {
      c.maxLossUsd = rec.operator.maxLossUsd;
      c.keepExtra = { sol: rec.operator.cashSol, eth: rec.operator.cashEth };
      c.locked = { pct: rec.operator.lockPct, pumpTokens: rec.operator.locked.pumpTokens, ponsTokens: rec.operator.locked.ponsTokens, solLock: rec.wallets.solLock ?? "", evmLock: rec.wallets.evmLock ?? "" };
    }
    if (!rec.retire) { rec.retire = newRetire(rec.launch.launchedAt ?? Date.now(), config.retire); registry.save(rec); }
    coins.set(rec.id, c);
    makers.arm(c);
    if (rec.retire.evaluated?.verdict === "selldown") makers.setMode(rec.id, "selldown");
    return c;
  };
  const unmount = (id: string) => {
    makers.disarm(id);
    coins.delete(id);
  };
  for (const rec of registry.list({ status: ["live"] })) mount(rec);
  poller.start();

  // ---- quote from live chain params. AUTO_SIZE: the pool fronts what it can spare per open slot, between
  // FRONT_*_MIN and FRONT_*; SOL never above the parity dev buy (pump.fun landing on the Pons floor) since
  // beyond that the ETH side would have to grow too. A deployer boost sits on top of the pool's part.
  let balancesAt = 0, balancesMemo = { sol: 0, eth: 0 };
  const poolBalances = async () => {
    if (Date.now() - balancesAt > 15_000) { balancesMemo = await pool.balances(); balancesAt = Date.now(); }
    return balancesMemo;
  };
  const freeNow = async (launchFee: number) => {
    const b = await poolBalances();
    const drawing = registry.list({ status: ["paid", "approved", "launching"] }).filter((r) => !r.front.at);
    const perLaunchEth = launchFee + config.launch.evmGasLauncher;
    const reservedSol = drawing.reduce((s, r) => s + r.front.sol - r.boostSol, 0);
    const reservedEth = drawing.reduce((s, r) => s + r.front.eth + perLaunchEth, 0);
    const busy = registry.list({ status: ["live", "launching", "approved", "paid"] }).length;
    return { sol: b.sol - config.pool.minSol - reservedSol, eth: b.eth - config.pool.minEth - reservedEth - perLaunchEth, slots: Math.max(1, config.launch.maxLiveMakers - busy), balances: b };
  };
  // Pons factory params (fee, curve config) move rarely and cost five contract reads; the quote is polled
  // by every open home page, so memoize them like the balances. The launcher reads them fresh.
  let preflightAt = 0, preflightMemo: Awaited<ReturnType<typeof launchPreflight>> | null = null;
  const preflight = async () => {
    if (!preflightMemo || Date.now() - preflightAt > 15_000) { preflightMemo = await launchPreflight(pub, PONS.ZERO); preflightAt = Date.now(); }
    return preflightMemo;
  };
  const quoteNow = async (boostSol = 0) => {
    const [rates, pf] = await Promise.all([fx(), preflight()]);
    const pons = { phantomEth: Number(formatEther(pf.config.phantomQuote)), supply: Number(formatEther(pf.config.supply)), feeBps: Number(pf.config.curveFeeBps), creatorTaxBps: config.evm.creatorTaxBps };
    let front = { sol: config.launch.frontSol, eth: config.launch.frontEth };
    if (config.launch.autoSize) {
      const free = await freeNow(Number(formatEther(pf.launchFee)));
      const parity = buildQuote({ depositSol: 0, frontSol: 1, frontEth: 1, solGasBudget: 0, evmMakerCash: 0, fx: rates, pons }).parityDevBuySol;
      const maxSol = Math.min(config.launch.frontSol, frontForDevBuy(parity, config.launch.solGasBudget));
      front = sizeFront(free, { sol: config.launch.frontSolMin, eth: config.launch.frontEthMin }, { sol: maxSol, eth: config.launch.frontEth });
    }
    return buildQuote({
      depositSol: config.launch.depositSol, frontSol: front.sol, frontEth: front.eth, boostSol,
      solGasBudget: config.launch.solGasBudget, evmMakerCash: config.launch.evmMakerCash, fx: rates, pons,
    });
  };
  /** True when the pool cannot front even the minimum right now (nothing is reserved for the caller). */
  const poolShort = async () => {
    if (!config.launch.autoSize) return false;
    const pf = await preflight();
    const free = await freeNow(Number(formatEther(pf.launchFee)));
    return free.sol < config.launch.frontSolMin || free.eth < config.launch.frontEthMin;
  };

  // ---- launches
  const launch = async (rec: LaunchRecord) => {
    await runLaunch({ cfg: config, registry, pool, conn, pub, fx }, rec);
    if (rec.status === "live") mount(rec);
  };
  const chains = { conn, pub, rpcUrl: config.evm.rpcUrl };
  const watcher = new PaymentWatcher(chains, registry);
  watcher.start();
  const scheduler = new Scheduler(registry, {
    autoApprove: config.launch.autoApprove, maxLiveMakers: config.launch.maxLiveMakers,
    autoRetries: config.launch.autoRetries, retryBackoffMs: config.launch.retryBackoffMin * 60_000, closed: config.launch.launchesClosed,
  }, launch);
  scheduler.start();
  if (scheduler.closed) console.error("[scheduler] LAUNCHES_CLOSED: refusing new launches and holding the queue");

  // ---- exit policy + close
  const closing = new Set<string>();
  const close = async (r: LaunchRecord, reason: string) => {
    if (closing.has(r.id)) throw new HttpError(409, "already closing");
    closing.add(r.id);
    try {
      unmount(r.id);
      await closeCoin({ cfg: config, registry, pool, conn, pub }, r, reason);
    } finally {
      closing.delete(r.id);
    }
  };
  const breaker = (reason: string) => {
    if (scheduler.paused) return;
    scheduler.pause(reason);
    makers.haltAll(`breaker: ${reason}`);
    void alert(`POOL BREAKER: ${reason}. Every maker halted, approvals paused. Resume with /api/admin/pool/resume.`);
  };
  const retirer = new Retirer({ cfg: config, registry, pool, conn, pub }, () => [...coins.values()], makers, close, breaker);
  retirer.start();
  for (const rec of registry.list({ status: ["closing"] })) close(rec, rec.retire?.reason ?? "resume").catch((e) => console.error("[close]", (e as Error).message)); // resume after a crash

  // ---- api
  const router = new Router(config.launch.adminToken);
  const CLOSED_MSG = "launches are closed right now";
  const limiter = new RateLimit(60_000);
  const rec = (id: string) => {
    const r = registry.get(id);
    if (!r) throw new HttpError(404, "no such launch");
    return r;
  };

  router.get("/api/health", () => ({ ok: true, launches: scheduler.closed ? "closed" : "open", coins: coins.size, updatedAt: Date.now() }));
  /** Hidden launches drop out of the public lists, but the admin page reads the same two routes, so a valid token sees everything. */
  const isAdmin = (h: ApiHeaders) => !!config.launch.adminToken && h["x-admin-token"] === config.launch.adminToken;
  router.get("/api/coins", (_p, _b, h) => [...coins.values()].filter((c) => isAdmin(h) || !registry.get(c.id)?.hidden).map((c) => c.summary()));
  router.get("/api/coins/:id/state", (p, _b, h) => {
    const c = coins.get(p.id);
    if (!c) throw new HttpError(404, "no such coin");
    const r = query(h).range;
    return c.snapshot(r === "1h" || r === "6h" ? r : "24h");
  });
  router.get("/api/paid", (_p, _b, h) => registry.list().filter((r) => !isBanned(r) && (isAdmin(h) || !r.hidden)).map(publicRecord));
  router.get("/api/paid/quote", (_p, _b, h) => {
    const boost = Number(query(h).boost ?? 0);
    if (!Number.isFinite(boost) || boost < 0 || boost > config.launch.maxBoostSol) throw new HttpError(400, `boost must be 0..${config.launch.maxBoostSol} SOL`);
    return quoteNow(boost);
  });
  router.get("/api/paid/:id", (p) => publicRecord(rec(p.id)));
  router.post("/api/paid", async (_p, body, _h, ip) => {
    if (scheduler.closed) throw new HttpError(503, CLOSED_MSG);
    if (!limiter.allow(ip)) throw new HttpError(429, "one launch per minute per address");
    if (registry.list({ status: OPEN_STATUSES }).length >= config.launch.maxOpenLaunches) throw new HttpError(503, "launches are full right now");
    if (!config.pinataJwt) throw new HttpError(503, "PINATA_JWT not configured");
    const b = (body ?? {}) as { name?: unknown; symbol?: unknown; devWallet?: unknown };
    const why = bans.refuse({ name: String(b.name ?? ""), symbol: String(b.symbol ?? ""), devWallet: String(b.devWallet ?? "") });
    if (why) throw new HttpError(403, why);
    if (await poolShort()) throw new HttpError(503, "the pool cannot front a launch right now; try again later");
    return createLaunch({
      registry, deadlineMin: config.launch.depositDeadlineMin, now: Date.now, quote: quoteNow, maxBoostSol: config.launch.maxBoostSol, publicUrl: config.server.publicUrl,
      pin: { file: (f, n) => pinFile(config.pinataJwt, f, n), json: (o, n) => pinJson(config.pinataJwt, o, n) },
    }, body);
  });
  /** ETH deposits: the payer (or the page, right after the wallet sends) submits the tx hash; the watcher verifies it over RPC. */
  router.post("/api/paid/:id/tx", (p, body) => {
    const r = rec(p.id);
    const hash = typeof (body as { hash?: unknown })?.hash === "string" ? (body as { hash: string }).hash.trim() : "";
    if (r.payment.chain !== "eth") throw new HttpError(409, "this launch is paid in SOL; the watcher finds SOL payments on its own");
    if (r.status !== "awaiting_deposit") throw new HttpError(409, `status is ${r.status}`);
    if (!ETH_TX_HASH.test(hash)) throw new HttpError(400, "hash must be a 0x-prefixed 32-byte tx hash");
    const known = [...r.payment.txs, ...r.payment.foreign].map((t) => t.tx.toLowerCase());
    if (!known.includes(hash.toLowerCase()) && !r.payment.claimed.some((h) => h.toLowerCase() === hash.toLowerCase())) {
      if (r.payment.claimed.length >= 20) throw new HttpError(429, "too many pending hashes");
      r.payment.claimed.push(hash);
      registry.save(r);
      void watcher.tick().catch((e) => console.error("[payments]", (e as Error).message));
    }
    return publicRecord(r);
  });
  router.get("/api/pool", () => pool.summary(registry));
  router.get("/api/chain/blockhash", async () => ({ blockhash: (await conn.getLatestBlockhash("confirmed")).blockhash }));

  // ---- operator launch (hidden page): lock + two-sided open from the pool, straight into the queue
  // selfFunded without wallets = the bundle page previewing the shape before any key is pasted.
  const operatorShape = async (op: OperatorInput, selfFunded = !!op.wallets) => {
    const [rates, pf] = await Promise.all([fx(), preflight()]);
    const { wallets, ...rest } = op;
    const inputs = {
      ...rest, selfFunded: selfFunded || !!wallets, buyers: buyerTotals(wallets), fx: rates,
      pons: { phantomEth: Number(formatEther(pf.config.phantomQuote)), supply: Number(formatEther(pf.config.supply)), feeBps: Number(pf.config.curveFeeBps), creatorTaxBps: config.evm.creatorTaxBps },
      solGasBudget: config.launch.solGasBudget, evmMakerCash: config.launch.evmMakerCash,
      launcherEth: Number(formatEther(pf.launchFee)) + config.launch.evmGasLauncher,
    };
    return { shape: shapeQuote(inputs), inputs };
  };
  router.get("/api/admin/launch/quote", async (_p, _b, h) => {
    const q = query(h);
    const op = validateOperatorInput({ lockPct: q.lockPct ?? 15, bundleSol: q.bundleSol ?? 1, ponsEth: q.ponsEth ?? 0.01, cashSol: q.cashSol ?? 0, cashEth: q.cashEth ?? 0, maxLossUsd: q.maxLossUsd ?? null });
    const { shape } = await operatorShape(op);
    const b = await poolBalances();
    const free = { sol: Math.round((b.sol - config.pool.minSol) * 1e6) / 1e6, eth: Math.round((b.eth - config.pool.minEth) * 1e6) / 1e6 };
    return { shape, pool: { balances: b, free, ok: free.sol >= shape.pool.sol && free.eth >= shape.pool.eth, floors: { sol: config.pool.minSol, eth: config.pool.minEth } }, lockEthExtra: LOCK_ETH_EXTRA };
  }, { admin: true });
  const checkFunding = (w: NonNullable<OperatorInput["wallets"]>, need: { devSol: number; devEth: number }) => checkBundleFunding(conn, pub, w, need);
  // Self-funded bundle: the shape plus the live balances of the pasted wallets against what each must hold. Keys are parsed
  // and dropped; nothing is stored or moved.
  router.post("/api/admin/launch/check", async (_p, body) => {
    const op = validateOperatorInput(body);
    const { shape } = await operatorShape(op, (body as { selfFunded?: unknown })?.selfFunded === true);
    const b = await poolBalances();
    const free = { sol: Math.round((b.sol - config.pool.minSol) * 1e6) / 1e6, eth: Math.round((b.eth - config.pool.minEth) * 1e6) / 1e6 };
    const wallets = op.wallets ? await checkFunding(op.wallets, { devSol: shape.lock.fundSol, devEth: shape.lock.fundEth }) : null;
    return { shape, pool: { balances: b, free, ok: free.sol >= shape.pool.sol && free.eth >= shape.pool.eth, floors: { sol: config.pool.minSol, eth: config.pool.minEth } }, wallets, limits: BUNDLE_LIMITS, lockEthExtra: LOCK_ETH_EXTRA };
  }, { admin: true });
  router.post("/api/admin/launch", async (_p, body) => {
    if (scheduler.closed) throw new HttpError(409, `${CLOSED_MSG} (LAUNCHES_CLOSED)`);
    if (scheduler.paused) throw new HttpError(409, "pool is paused (breaker); resume first");
    const { rec: r, shape } = await createOperatorLaunch({ registry, now: Date.now, publicUrl: config.server.publicUrl, pin: { file: (f, n) => pinFile(config.pinataJwt, f, n), json: (o, n) => pinJson(config.pinataJwt, o, n) }, shape: operatorShape, checkFunding }, body);
    console.log(`[operator] launch ${r.id} queued: lock ${shape.lock.pct}% bundle ${shape.pump.devBuySol} SOL / ${shape.pons.eth} ETH${shape.selfFunded ? ` self-funded, ${shape.buyers.count} buyers` : ""}`);
    void scheduler.tick();
    return { record: publicRecord(r), shape };
  }, { admin: true });

  router.post("/api/admin/paid/:id/approve", (p) => {
    const r = rec(p.id);
    if (r.status !== "paid") throw new HttpError(409, `status is ${r.status}`);
    if (scheduler.closed) throw new HttpError(409, `${CLOSED_MSG} (LAUNCHES_CLOSED)`);
    approve(r, Date.now(), false);
    registry.save(r);
    void scheduler.tick();
    return r;
  }, { admin: true });
  router.post("/api/admin/paid/:id/reject", async (p, body) => {
    const r = rec(p.id);
    const note = typeof (body as { note?: unknown })?.note === "string" ? (body as { note: string }).note : null;
    if (!["awaiting_deposit", "paid", "approved"].includes(r.status)) throw new HttpError(409, `status is ${r.status}`);
    reject(r, Date.now(), note);
    registry.save(r);
    await refundDeposit(chains, registry, r, Date.now());
    return r;
  }, { admin: true });
  router.post("/api/admin/paid/:id/retry", (p) => {
    const r = rec(p.id);
    if (r.status !== "failed") throw new HttpError(409, `status is ${r.status}`);
    if (scheduler.closed) throw new HttpError(409, `${CLOSED_MSG} (LAUNCHES_CLOSED)`);
    transition(r, "approved", Date.now());
    registry.save(r);
    void scheduler.tick();
    return r;
  }, { admin: true });
  /**
   * Ban: the deployer's wallet and the payer may not launch again, the record is rejected, whatever the pool fronted
   * comes back (a funded or failed launch is closed: per-coin wallets swept), and the deposit goes back to the payer
   * — from the payment address if it is still there, else from the pool. Body: { note?, names?: string[], refund?: false }.
   */
  router.post("/api/admin/paid/:id/ban", async (p, body) => {
    const r = rec(p.id);
    const b = (body ?? {}) as { note?: unknown; names?: unknown; refund?: unknown };
    const note = typeof b.note === "string" ? b.note : "banned";
    if (["launching", "live", "closing"].includes(r.status)) throw new HttpError(409, `status is ${r.status}; close it first`);
    const names = Array.isArray(b.names) ? b.names.map(String) : [];
    bans.add({ wallets: [r.devWallet, r.payment.from ?? ""], names });
    if (r.approval.status !== "rejected") r.approval = { status: "rejected", at: Date.now(), note, auto: false };
    step(r, "banned", Date.now(), { note, wallets: [r.devWallet, r.payment.from].filter(Boolean) });
    registry.save(r);
    if (["awaiting_deposit", "paid", "approved"].includes(r.status) && !r.front.at) {
      transition(r, "rejected", Date.now());
      registry.save(r);
      await refundDeposit(chains, registry, r, Date.now());
    } else if (["approved", "failed"].includes(r.status)) {
      await close(r, note);
    }
    const owed = Math.round((r.payment.received - r.refund.amount) * 1e9) / 1e9;
    const refund = b.refund === false || !r.payment.toPoolTx || r.payment.toPoolTx === "none" || owed <= 0
      ? null
      : await refundFromPool(pool, registry, r, Date.now(), { reason: "ban" });
    return { record: publicRecord(r), refund, bans: bans.list() };
  }, { admin: true });
  /** Refund from the pool. Defaults: the payer, what they paid minus refunds so far. { to, amount } for an unclaimed transfer the deposit sweep picked up. */
  router.post("/api/admin/paid/:id/refund", async (p, body) => {
    const r = rec(p.id);
    const b = (body ?? {}) as { to?: unknown; amount?: unknown; reason?: unknown };
    const to = typeof b.to === "string" && b.to.trim() ? b.to.trim() : undefined;
    const amount = b.amount == null || b.amount === "" ? undefined : Number(b.amount);
    if (amount != null && !(amount > 0)) throw new HttpError(400, "amount must be positive");
    if (!to && (!r.payment.toPoolTx || r.payment.toPoolTx === "none")) throw new HttpError(409, "the deposit is still on the payment address; reject or ban refunds it from there");
    const refund = await refundFromPool(pool, registry, r, Date.now(), { to, amount, reason: typeof b.reason === "string" ? b.reason : "admin" });
    return { record: publicRecord(r), refund };
  }, { admin: true });
  router.get("/api/admin/bans", () => bans.list(), { admin: true });
  router.post("/api/admin/bans", (_p, body) => {
    const b = (body ?? {}) as Partial<BanList>;
    return bans.add({ wallets: Array.isArray(b.wallets) ? b.wallets.map(String) : [], names: Array.isArray(b.names) ? b.names.map(String) : [] });
  }, { admin: true });
  router.post("/api/admin/bans/remove", (_p, body) => {
    const b = (body ?? {}) as Partial<BanList>;
    return bans.remove({ wallets: Array.isArray(b.wallets) ? b.wallets.map(String) : [], names: Array.isArray(b.names) ? b.names.map(String) : [] });
  }, { admin: true });
  router.post("/api/admin/coins/:id/maker/halt", (p) => ({ ok: makers.halt(p.id) }), { admin: true });
  router.post("/api/admin/coins/:id/maker/resume", (p) => ({ ok: makers.resume(p.id) }), { admin: true });
  /** Close now: sell inventory back, collect fees, sweep every per-coin wallet to the pool. live, failed or a stuck closing. */
  /** Move the Solana maker off the pump.fun creator wallet (launches from before the creator/maker split). */
  router.post("/api/admin/coins/:id/maker/rotate", async (p) => {
    const r = rec(p.id);
    if (r.status !== "live") throw new HttpError(409, `status is ${r.status}`);
    const c = coins.get(p.id);
    if (!c) throw new HttpError(409, "coin is not armed");
    if (r.wallets.solMaker && r.wallets.solMaker !== r.wallets.solCreator) throw new HttpError(409, `maker is already ${r.wallets.solMaker}`);
    await makers.park(p.id, "rotating maker");
    try {
      return await rotateSolMaker(conn, registry, r);
    } finally {
      c.maker.halted = false;
      c.maker.haltReason = null;
      makers.arm(c);
    }
  }, { admin: true });
  router.post("/api/admin/coins/:id/close", async (p, body) => {
    const r = rec(p.id);
    if (!["live", "failed", "closing"].includes(r.status)) throw new HttpError(409, `status is ${r.status}`);
    const note = typeof (body as { reason?: unknown })?.reason === "string" ? (body as { reason: string }).reason : "admin";
    await close(r, note);
    return r;
  }, { admin: true });
  /** Keep: the exit timer leaves this coin alone; a selldown in progress goes back to pegging. */
  router.post("/api/admin/coins/:id/keep", (p) => {
    const r = rec(p.id);
    if (r.status !== "live") throw new HttpError(409, `status is ${r.status}`);
    if (!r.retire) r.retire = newRetire(r.launch.launchedAt ?? r.createdAt, config.retire);
    r.retire.keep = true;
    step(r, "exit_keep", Date.now());
    registry.save(r);
    makers.setMode(r.id, "peg");
    return r;
  }, { admin: true });
  router.post("/api/admin/pool/resume", () => {
    scheduler.unpause();
    for (const c of coins.values()) makers.resume(c.id);
    return { ok: true, paused: scheduler.paused };
  }, { admin: true });
  /**
   * Consolidate every per-coin EVM wallet into the pool wallet. Dry run by default: POST {"confirm":true} moves ETH.
   * A live coin's maker and launcher are skipped unless {"includeLive":true} — sweeping them leaves the maker without gas.
   */
  /** Hide or unhide launches in the public lists. POST {"hidden":true} with :id "all" for every record. */
  router.post("/api/admin/paid/:id/hidden", (p, body) => {
    const hidden = (body as { hidden?: unknown })?.hidden !== false;
    const targets = p.id === "all" ? registry.list() : [rec(p.id)];
    for (const r of targets) {
      if (r.hidden === hidden) continue;
      r.hidden = hidden;
      step(r, hidden ? "hidden" : "unhidden", Date.now());
      registry.save(r);
    }
    return { hidden, ids: targets.map((r) => r.id) };
  }, { admin: true });

  router.post("/api/admin/pool/sweep-eth", async (_p, body) => {
    const b = (body ?? {}) as { confirm?: unknown; includeLive?: unknown };
    const confirm = b.confirm === true;
    const includeLive = b.includeLive === true;
    const rows: { id: string; wallet: string; address: string; eth: number; tx?: string; skipped?: string; error?: string }[] = [];
    for (const r of registry.list()) {
      const live = r.status === "live" || r.status === "launching";
      const keys = registry.keys(r.id);
      const wallets: [string, string | undefined, string][] = [
        ["evmMaker", keys.evmMaker, r.wallets.evmMaker],
        ["evmLauncher", keys.evmLauncher, r.wallets.evmLauncher],
        ["evmPayment", keys.evmPayment, r.wallets.evmPayment],
      ];
      for (const [wallet, key, address] of wallets) {
        if (!key || !address) continue;
        const eth = Number(formatEther(await pub.getBalance({ address: address as `0x${string}` })));
        if (eth === 0) continue;
        if (live && includeLive === false && wallet !== "evmPayment") { rows.push({ id: r.id, wallet, address, eth, skipped: "coin is live" }); continue; }
        if (!confirm) { rows.push({ id: r.id, wallet, address, eth, skipped: "dry run" }); continue; }
        try {
          const done = await sweepEth(pub, config.evm.rpcUrl, key, pool.evmAddress);
          rows.push({ id: r.id, wallet, address, eth: done?.eth ?? 0, tx: done?.sig });
        } catch (e) {
          rows.push({ id: r.id, wallet, address, eth, error: (e as Error).message });
        }
      }
    }
    const balances = await pool.balances();
    const moved = rows.filter((x) => x.tx).reduce((a, x) => a + x.eth, 0);
    return { confirm, includeLive, wallets: rows, moved, pool: { address: pool.evmAddress, eth: balances.eth } };
  }, { admin: true });

  router.get("/api/admin/pool/status", () => ({
    paused: scheduler.paused, closed: scheduler.closed, closing: [...closing],
    coins: [...coins.values()].map((c) => ({ id: c.id, lossUsd: c.maker.lossUsd, mode: c.maker.mode, front: c.front, repaid: c.repaid, retiredAt: c.retiredAt })),
  }), { admin: true });

  serve(router, config.server.port, config.server.corsOrigin);

  // Resume launches a restart interrupted — only once the API is listening, so a deploy never takes the site
  // offline for as long as a launch takes to replay (Railway answers 502 until the port is bound).
  for (const rec of registry.list({ status: ["launching"] })) {
    try {
      await launch(rec);
    } catch (e) {
      console.error(`[launch ${rec.id}] resume failed: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
