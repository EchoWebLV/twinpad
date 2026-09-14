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
import { PaymentWatcher, refundDeposit } from "./payments.js";
import { Scheduler, approve, reject } from "./scheduler.js";
import { runLaunch } from "./launcher.js";
import { CoinState } from "./coin.js";
import { Poller } from "./poller.js";
import { Makers } from "./makers.js";
import { Router, RateLimit, HttpError, serve, query } from "./api.js";
import { OPEN_STATUSES, transition, publicRecord, type LaunchRecord } from "./record.js";

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
    coins.set(rec.id, c);
    makers.arm(c);
    return c;
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
  new PaymentWatcher(conn, registry).start();
  const scheduler = new Scheduler(registry, { autoApprove: config.launch.autoApprove, maxLiveMakers: config.launch.maxLiveMakers }, launch);
  scheduler.start();

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
      registry, deadlineMin: config.launch.depositDeadlineMin, now: Date.now, quote: quoteNow,
      pin: { file: (f, n) => pinFile(config.pinataJwt, f, n), json: (o, n) => pinJson(config.pinataJwt, o, n) },
    }, body);
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
    await refundDeposit(conn, registry, r, Date.now());
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

  serve(router, config.server.port, config.server.corsOrigin);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
