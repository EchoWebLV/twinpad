import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Registry } from "./registry.js";
import { BUNDLE_LIMITS, LOCK_ETH_EXTRA, LOCK_SOL_EXTRA, buyerNeedEth, buyerNeedSol, checkBundleFunding, parseBundleWallets, parseBuyers } from "./bundle.js";
import { buyerTotals, createOperatorLaunch, shapeQuote, validateOperatorInput, type ShapeInputs } from "./operator.js";
import { BUY_FEE_RATE } from "./quote.js";

const solKey = () => bs58.encode(Keypair.generate().secretKey);
const PONS = { phantomEth: 1.68, supply: 1e9, feeBps: 100, creatorTaxBps: 200 };
const base = (over: Partial<ShapeInputs> = {}): ShapeInputs => ({
  lockPct: 15, bundleSol: 19.46, ponsEth: 0.5284, cashSol: 2, cashEth: 0.07, maxLossUsd: 500,
  fx: { SOL: 102.8, ETH: 2532 }, pons: PONS, solGasBudget: 0.13, evmMakerCash: 0.01, launcherEth: 0.0125, ...over,
});

test("parseBuyers: one wallet a line, '-' skips a chain, amounts are checked against the keys", () => {
  const a = solKey(), e = generatePrivateKey();
  const rows = parseBuyers(`# comment\n${a} ${e} 0.5 0.01\n${solKey()}, -, 0.25, 0\n- ${generatePrivateKey()} 0 0.02\n`);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].sol?.publicKey.toBase58(), Keypair.fromSecretKey(bs58.decode(a)).publicKey.toBase58());
  assert.equal(rows[0].evm, e.toLowerCase());
  assert.deepEqual([rows[0].buySol, rows[0].buyEth], [0.5, 0.01]);
  assert.equal(rows[1].evm, null);
  assert.equal(rows[2].sol, null);
  assert.throws(() => parseBuyers(`${solKey()} - 0 0`), /buys nothing/);
  assert.throws(() => parseBuyers(`- ${generatePrivateKey()} 0.5 0`), /no Solana key/);
  assert.throws(() => parseBuyers(`${solKey()} - 0 0.1`), /no Robinhood key/);
  assert.throws(() => parseBuyers(`notakey - 0.1 0`), /base58 secret key/);
  assert.throws(() => parseBuyers(`${solKey()} 0xabc 0.1 0`), /32-byte private key/);
  assert.throws(() => parseBuyers(`${solKey()} - 0.1`), /expected/);
  assert.throws(() => parseBuyers(`${solKey()} - ${BUNDLE_LIMITS.buySolMax + 1} 0`), /max/);
  assert.throws(() => parseBuyers(Array.from({ length: BUNDLE_LIMITS.maxBuyers + 1 }, () => `${solKey()} - 0.1 0`).join("\n")), /max 12/);
});

test("parseBundleWallets: dev wallet needs both keys, no wallet may repeat, empty = pool-funded", () => {
  assert.equal(parseBundleWallets(undefined), null);
  assert.equal(parseBundleWallets({ dev: { sol: "", evm: "" }, buyers: "" }), null);
  assert.throws(() => parseBundleWallets({ dev: { sol: solKey(), evm: "" } }), /Robinhood private key missing/);
  assert.throws(() => parseBundleWallets({ dev: { sol: "", evm: generatePrivateKey() } }), /Solana secret key missing/);
  const dev = { sol: solKey(), evm: generatePrivateKey() };
  assert.throws(() => parseBundleWallets({ dev, buyers: `${dev.sol} - 0.1 0` }), /repeats another wallet/);
  const b = solKey();
  assert.throws(() => parseBundleWallets({ dev, buyers: `${b} - 0.1 0\n${b} - 0.1 0` }), /buyer 2: Solana wallet repeats/);
  const w = parseBundleWallets({ dev, buyers: `${b} - 0.1 0` });
  assert.equal(w?.buyers.length, 1);
  assert.equal(w?.dev.evm, dev.evm.toLowerCase());
});

test("buyer need: pump.fun buy + fee rate + rent margin; Pons buy + gas margin", () => {
  assert.equal(buyerNeedSol(1), Math.round((1 * (1 + BUY_FEE_RATE) + LOCK_SOL_EXTRA) * 1e6) / 1e6);
  assert.equal(buyerNeedSol(0), 0);
  assert.equal(buyerNeedEth(0.02), Math.round((0.02 + LOCK_ETH_EXTRA) * 1e6) / 1e6);
  assert.equal(buyerNeedEth(0), 0);
});

test("checkBundleFunding: every pasted wallet is measured against its own need, short ones are named", async () => {
  const dev = { sol: solKey(), evm: generatePrivateKey() };
  const b1 = { sol: solKey(), evm: generatePrivateKey() };
  const w = parseBundleWallets({ dev, buyers: `${b1.sol} ${b1.evm} 0.5 0.01\n${solKey()} - 0.2 0` })!;
  const devSolAddr = w.dev.sol.publicKey.toBase58();
  const balances: Record<string, number> = { [devSolAddr]: 1.0, [w.buyers[0].sol!.publicKey.toBase58()]: 0.3, [w.buyers[1].sol!.publicKey.toBase58()]: 0.5 };
  const evmBalances: Record<string, bigint> = { [privateKeyToAccount(dev.evm).address]: 10n ** 17n, [privateKeyToAccount(b1.evm).address]: 5n * 10n ** 15n };
  const conn = { getBalance: async (pk: { toBase58(): string }) => Math.round((balances[pk.toBase58()] ?? 0) * 1e9) };
  const pub = { getBalance: async ({ address }: { address: string }) => evmBalances[address] ?? 0n };
  const c = await checkBundleFunding(conn as never, pub as never, w, { devSol: 0.8, devEth: 0.05 });
  assert.equal(c.ok, false);
  assert.equal(c.rows.length, 3);
  assert.equal(c.rows[0].sol?.ok, true);
  assert.equal(c.rows[0].evm?.ok, true);
  // buyer 1: 0.3 SOL < 0.5 × (1 + fee) + margin; 0.005 ETH < 0.011
  assert.equal(c.rows[1].sol?.ok, false);
  assert.equal(c.rows[1].evm?.ok, false);
  assert.equal(c.rows[2].sol?.ok, true);
  assert.equal(c.rows[2].evm, null);
  assert.equal(c.short.length, 2);
  assert.match(c.short[0], /buyer 1 holds 0.3 SOL/);
});

test("shape: a self-funded bundle keeps the lock money in the pool and lands the buyers after the maker", () => {
  const pooled = shapeQuote(base());
  const self = shapeQuote(base({ selfFunded: true, buyers: { sol: 2, eth: 0.05, count: 2 } }));
  assert.equal(self.selfFunded, true);
  assert.ok(Math.abs(self.pool.sol - (pooled.pool.sol - pooled.lock.fundSol)) < 1e-6);
  assert.ok(Math.abs(self.pool.eth - (pooled.pool.eth - pooled.lock.fundEth)) < 1e-6);
  // same lock and maker numbers; the buyers push the landing above the maker's
  assert.equal(self.lock.tokens, pooled.lock.tokens);
  assert.equal(self.pump.fdv, pooled.pump.fdv);
  assert.equal(self.buyers.count, 2);
  assert.ok(self.buyers.pumpTokens > 0 && self.buyers.ponsTokens > 0);
  assert.ok(self.buyers.pumpFdv > self.pump.fdv && self.buyers.ponsFdv > self.pons.fdv);
  assert.ok(self.buyers.pumpSupplyPct > 0 && self.buyers.pumpSupplyPct < self.pump.supplyPct);
  const none = shapeQuote(base({ selfFunded: true }));
  assert.equal(none.buyers.pumpFdv, none.pump.fdv);
  assert.equal(none.buyers.pumpTokens, 0);
});

test("validateOperatorInput carries the pasted wallets; buyerTotals sums them per chain", () => {
  const dev = { sol: solKey(), evm: generatePrivateKey() };
  const op = validateOperatorInput({ lockPct: 15, bundleSol: 1, ponsEth: 0.01, wallets: { dev, buyers: `${solKey()} ${generatePrivateKey()} 0.5 0.01\n${solKey()} - 0.25 0` } });
  assert.equal(op.wallets?.buyers.length, 2);
  assert.deepEqual(buyerTotals(op.wallets), { sol: 0.75, eth: 0.01, count: 2 });
  assert.deepEqual(buyerTotals(null), { sol: 0, eth: 0, count: 0 });
});

test("createOperatorLaunch with wallets: the dev wallet is the lock wallet, buyer keys are stored, nothing is fronted to them", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-"));
  const registry = new Registry(dir);
  const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64")}`;
  const dev = { sol: solKey(), evm: generatePrivateKey() };
  const b1 = { sol: solKey(), evm: generatePrivateKey() };
  const b2 = solKey();
  const shape = async (op: ReturnType<typeof validateOperatorInput>) => {
    const { wallets, ...rest } = op;
    const inputs = base({ ...rest, selfFunded: !!wallets, buyers: buyerTotals(wallets) });
    return { shape: shapeQuote(inputs), inputs };
  };
  const deps = { registry, now: () => 1_000, publicUrl: "https://x", pin: { file: async () => "cidImg", json: async () => "cidMeta" }, shape };
  const body = { name: "Bundle Coin", symbol: "bnd", description: "bundle", imageDataUrl: png, lockPct: 15, bundleSol: 19.46, ponsEth: 0.5284, cashSol: 2, cashEth: 0.07, maxLossUsd: 500, wallets: { dev, buyers: `${b1.sol} ${b1.evm} 0.5 0.01\n${b2} - 0.25 0` } };

  // a short wallet stops the launch before anything is written
  await assert.rejects(createOperatorLaunch({ ...deps, checkFunding: async () => ({ ok: false, rows: [], short: ["dev holds 0 SOL, needs 5"] }) }, body), /wallets short: dev holds 0 SOL/);
  assert.equal(registry.list().length, 0);

  let asked: { devSol: number; devEth: number } | null = null;
  const { rec, shape: s } = await createOperatorLaunch({ ...deps, checkFunding: async (_w, need) => { asked = need; return { ok: true, rows: [], short: [] }; } }, body);
  assert.deepEqual(asked, { devSol: s.lock.fundSol, devEth: s.lock.fundEth });
  assert.equal(rec.operator?.selfFunded, true);
  assert.equal(rec.wallets.solLock, Keypair.fromSecretKey(bs58.decode(dev.sol)).publicKey.toBase58());
  assert.equal(rec.wallets.evmLock, privateKeyToAccount(dev.evm).address);
  assert.equal(rec.operator?.bundle?.dev.sol, rec.wallets.solLock);
  assert.equal(rec.operator?.bundle?.buyers.length, 2);
  assert.equal(rec.operator?.bundle?.buyers[0].evm, privateKeyToAccount(b1.evm).address);
  assert.equal(rec.operator?.bundle?.buyers[1].evm, null);
  assert.deepEqual([rec.operator?.bundle?.buyers[0].buySol, rec.operator?.bundle?.buyers[0].buyEth], [0.5, 0.01]);
  assert.equal(rec.operator?.bundle?.buyers[0].txSol, null);
  // the pool quote excludes the lock money
  assert.ok(Math.abs(s.pool.sol - s.pump.makerFrontSol) < 1e-6);
  const keys = registry.keys(rec.id);
  assert.deepEqual(keys.solLock, Array.from(bs58.decode(dev.sol)));
  assert.equal(keys.evmLock, dev.evm.toLowerCase());
  assert.equal(keys.buyers?.length, 2);
  assert.deepEqual(keys.buyers?.[0].sol, Array.from(bs58.decode(b1.sol)));
  assert.equal(keys.buyers?.[0].evm, b1.evm.toLowerCase());
  assert.equal(keys.buyers?.[1].evm, undefined);
  // no one else can read the keys
  assert.equal(fs.statSync(path.join(dir, "launches", rec.id, "keys.json")).mode & 0o777, 0o600);
  // the public record carries addresses only
  assert.ok(!JSON.stringify(rec).includes(dev.sol) && !JSON.stringify(rec).includes(b1.evm.slice(2)));

  // without wallets the lock wallets are generated and the pool pays
  const { rec: pooled, shape: ps } = await createOperatorLaunch(deps, { ...body, wallets: undefined });
  assert.equal(pooled.operator?.selfFunded, false);
  assert.equal(pooled.operator?.bundle, null);
  assert.ok(ps.pool.sol > ps.pump.makerFrontSol);
  assert.notEqual(pooled.wallets.solLock, rec.wallets.solLock);
});
