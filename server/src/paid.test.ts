import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Registry } from "./registry.js";
import { createLaunch, validateInput, type CreateDeps } from "./paid.js";

const png = "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]).toString("base64");
const good = { name: "Doggo", symbol: "DOGGO", description: "two chains", twitter: "", website: "", telegram: "", devWallet: "H6CSd2BAQ2qzztEMYTFPRMzPU4voZjhr8wswfpneFvLY", imageDataUrl: png };

function deps(): CreateDeps {
  return {
    registry: new Registry(fs.mkdtempSync(path.join(os.tmpdir(), "paid-"))),
    pin: { file: async () => "imgcid", json: async () => "metacid" },
    quote: async (boostSol: number) => ({
      depositSol: 0.1, depositEth: 0.004, frontSol: 1, frontEth: 0.03, devBuySol: 0.87 + boostSol, boostSol, parityDevBuySol: 6.6, pumpTokens: 1, ponsEth: 0.01, ponsTokens: 1, makerCashEth: 0.02,
      openingFdv: 100, landing: { pump: 100, pons: 100 }, supplyPct: { pump: 1, pons: 1 }, fx: { SOL: 100, ETH: 2500 },
    }),
    maxBoostSol: 5,
    deadlineMin: 60,
    publicUrl: "https://pad.example",
    now: () => 1_000,
  };
}

test("validateInput rejects bad fields", () => {
  assert.throws(() => validateInput({ ...good, symbol: "TOOLONGSYMBOL" }), /symbol/);
  assert.throws(() => validateInput({ ...good, devWallet: "nope" }), /devWallet/);
  assert.throws(() => validateInput({ ...good, imageDataUrl: "data:image/gif;base64,AAAA" }), /image/);
  assert.throws(() => validateInput({ ...good, name: "" }), /name/);
  assert.equal(validateInput(good).symbol, "DOGGO");
});

test("validateInput: payChain eth needs an EVM address, normalised to checksum", () => {
  const evm = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
  assert.throws(() => validateInput({ ...good, payChain: "eth" }), /EVM address/);
  assert.throws(() => validateInput({ ...good, payChain: "btc" }), /payChain/);
  const v = validateInput({ ...good, payChain: "eth", devWallet: evm });
  assert.equal(v.payChain, "eth");
  assert.equal(v.devWallet, "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
  assert.equal(validateInput(good).payChain, "sol");
});

test("createLaunch with payChain eth: ETH payment address, required = depositEth", async () => {
  const d = deps();
  const rec = await createLaunch(d, { ...good, payChain: "eth", devWallet: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" });
  assert.equal(rec.payment.chain, "eth");
  assert.equal(rec.payment.unit, "ETH");
  assert.equal(rec.payment.required, 0.004);
  assert.equal(rec.payment.address, rec.wallets.evmPayment);
  assert.match(rec.payment.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(rec.payment.expectedFrom, "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
  const keys = d.registry.keys(rec.id);
  assert.match(keys.evmPayment, /^0x[0-9a-f]{64}$/);
});

test("createLaunch writes record, keys and image", async () => {
  const d = deps();
  const rec = await createLaunch(d, good);
  assert.match(rec.id, /^doggo-/);
  assert.equal(rec.status, "awaiting_deposit");
  assert.equal(rec.payment.deadlineAt, 1_000 + 60 * 60_000);
  assert.equal(rec.token.metadataUri, "https://ipfs.io/ipfs/metacid");
  assert.equal(rec.token.website, `https://pad.example/coin/${rec.id}`);
  assert.ok(rec.wallets.pumpMint.length >= 32);
  assert.ok(rec.wallets.evmMaker.startsWith("0x"));
  assert.notEqual(rec.wallets.solMaker, rec.wallets.solCreator);
  const keys = d.registry.keys(rec.id);
  assert.equal(keys.mint.length, 64);
  assert.ok(fs.existsSync(d.registry.imagePath(rec.id)));
  assert.equal(d.registry.get(rec.id)?.wallets.payment, rec.payment.address);
  assert.equal(rec.payment.chain, "sol");
  assert.equal(rec.payment.required, 0.1);
});

test("boostSol: bounded, SOL deposits only, rides in the deposit and the pool fronts it", async () => {
  assert.throws(() => validateInput({ ...good, boostSol: 6 }, 5), /max 5/);
  assert.throws(() => validateInput({ ...good, boostSol: 1 }, 0), /off/);
  assert.throws(() => validateInput({ ...good, boostSol: -1 }, 5), /non-negative/);
  assert.throws(() => validateInput({ ...good, boostSol: "abc" }, 5), /non-negative/);
  assert.throws(() => validateInput({ ...good, payChain: "eth", devWallet: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045", boostSol: 1 }, 5), /SOL deposit/);
  assert.equal(validateInput({ ...good, boostSol: "" }, 5).boostSol, 0);
  assert.equal(validateInput(good).boostSol, 0);
  const d = deps();
  const rec = await createLaunch(d, { ...good, boostSol: 2.5 });
  assert.equal(rec.boostSol, 2.5);
  assert.equal(rec.payment.required, 2.6); // deposit 0.1 + boost 2.5
  assert.equal(rec.front.sol, 3.5); // pool part 1 + boost 2.5 go to the creator wallet
  assert.equal(rec.quote.devBuySol, 3.37);
  assert.equal(rec.front.topupEth, 0);
  assert.equal(rec.front.retiredAt, null);
});
