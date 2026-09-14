import { formatEther } from "viem";
import { config, redactedConfig } from "./config.js";
import { Registry } from "./registry.js";
import { Pool } from "./pool.js";
import { connection } from "./solana/pump.js";
import { publicClient, launchPreflight, PONS } from "./evm/pons.js";
import { fx } from "./fx.js";
import { pinFile, pinJson } from "./ipfs.js";
import { createLaunch } from "./paid.js";
import { buildQuote } from "./quote.js";
import { ETH_TX_HASH, PaymentWatcher, refundDeposit } from "./payments.js";
import { Scheduler, approve, reject } from "./scheduler.js";
import { runLaunch } from "./launcher.js";
import { CoinState } from "./coin.js";
import { Poller } from "./poller.js";
import { Makers } from "./makers.js";
import { Router, RateLimit, HttpError, serve, query } from "./api.js";
import { OPEN_STATUSES, newRetire, step, transition, publicRecord, type LaunchRecord } from "./record.js";
import { closeCoin, Retirer } from "./retire.js";
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

  // ---- live coins
  const coins = new Map<string, CoinState>();
  const makers = new Makers(config, registry, conn, pub);
  const mount = (rec: LaunchRecord) => {
    if (coins.has(rec.id)) return coins.get(rec.id)!;
    const c = new CoinState(
      config.server.dataDir, rec.id, config.maker.band,
      { pumpMint: rec.launch.pumpMint!, ponsToken: rec.launch.ponsToken!, ponsCurve: rec.launch.ponsCurve!, launchedAt: rec.launch.launchedAt, name: rec.token.name, symbol: rec.token.symbol },
      { name: rec.token.name, symbol: rec.token.symbol, image: `https://gateway.pinata.cloud/ipfs/${rec.token.imageCid}`, twitter: rec.token.twitter, website: rec.token.website, description: rec.token.description },
    );
    c.front = { sol: rec.front.sol, eth: rec.front.eth };
    c.entryPrice = rec.seed ? rec.seed.openingFdv / 1e9 : 0;
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
  new Poller(conn, pub, () => [...coins.values()]).start();

  // ---- quote from live chain params
  const quoteNow = async () => {
    const [rates, pf] = await Promise.all([fx(), launchPreflight(pub, PONS.ZERO)]);
    return buildQuote({
      depositSol: config.launch.depositSol, frontSol: config.launch.frontSol, frontEth: config.launch.frontEth,
      solGasBudget: config.launch.solGasBudget, evmMakerCash: config.launch.evmMakerCash, fx: rates,
      pons: { phantomEth: Number(formatEther(pf.config.phantomQuote)), supply: Number(formatEther(pf.config.supply)), feeBps: Number(pf.config.curveFeeBps), creatorTaxBps: config.evm.creatorTaxBps },
    });
  };

  // ---- launches
  const launch = async (rec: LaunchRecord) => {
    await runLaunch({ cfg: config, registry, pool, conn, pub, fx }, rec);
    if (rec.status === "live") mount(rec);
  };
  for (const rec of registry.list({ status: ["launching"] })) await launch(rec); // resume after a crash
  const chains = { conn, pub, rpcUrl: config.evm.rpcUrl };
  const watcher = new PaymentWatcher(chains, registry);
  watcher.start();
  const scheduler = new Scheduler(registry, {
    autoApprove: config.launch.autoApprove, maxLiveMakers: config.launch.maxLiveMakers,
    autoRetries: config.launch.autoRetries, retryBackoffMs: config.launch.retryBackoffMin * 60_000,
  }, launch);
  scheduler.start();

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
  const limiter = new RateLimit(60_000);
  const rec = (id: string) => {
    const r = registry.get(id);
    if (!r) throw new HttpError(404, "no such launch");
    return r;
  };

  router.get("/api/health", () => ({ ok: true, coins: coins.size, updatedAt: Date.now() }));
  router.get("/api/coins", () => [...coins.values()].map((c) => c.summary()));
  router.get("/api/coins/:id/state", (p, _b, h) => {
    const c = coins.get(p.id);
    if (!c) throw new HttpError(404, "no such coin");
    const r = query(h).range;
    return c.snapshot(r === "1h" || r === "6h" ? r : "24h");
  });
  router.get("/api/paid", () => registry.list().map(publicRecord));
  router.get("/api/paid/quote", () => quoteNow());
  router.get("/api/paid/:id", (p) => publicRecord(rec(p.id)));
  router.post("/api/paid", async (_p, body, _h, ip) => {
    if (!limiter.allow(ip)) throw new HttpError(429, "one launch per minute per address");
    if (registry.list({ status: OPEN_STATUSES }).length >= config.launch.maxOpenLaunches) throw new HttpError(503, "launches are full right now");
    if (!config.pinataJwt) throw new HttpError(503, "PINATA_JWT not configured");
    return createLaunch({
      registry, deadlineMin: config.launch.depositDeadlineMin, now: Date.now, quote: quoteNow, publicUrl: config.server.publicUrl,
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

  router.post("/api/admin/paid/:id/approve", (p) => {
    const r = rec(p.id);
    if (r.status !== "paid") throw new HttpError(409, `status is ${r.status}`);
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
    transition(r, "approved", Date.now());
    registry.save(r);
    void scheduler.tick();
    return r;
  }, { admin: true });
  router.post("/api/admin/coins/:id/maker/halt", (p) => ({ ok: makers.halt(p.id) }), { admin: true });
  router.post("/api/admin/coins/:id/maker/resume", (p) => ({ ok: makers.resume(p.id) }), { admin: true });
  /** Close now: sell inventory back, collect fees, sweep every per-coin wallet to the pool. live, failed or a stuck closing. */
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
  router.get("/api/admin/pool/status", () => ({ paused: scheduler.paused, closing: [...closing], lossUsd: [...coins.values()].map((c) => ({ id: c.id, lossUsd: c.maker.lossUsd, mode: c.maker.mode })) }), { admin: true });

  serve(router, config.server.port, config.server.corsOrigin);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
