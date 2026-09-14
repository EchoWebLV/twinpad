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
    quote: async () => ({
      depositSol: 0.1, frontSol: 1, frontEth: 0.03, devBuySol: 0.87, pumpTokens: 1, ponsEth: 0.01, ponsTokens: 1, makerCashEth: 0.02,
      openingFdv: 100, landing: { pump: 100, pons: 100 }, supplyPct: { pump: 1, pons: 1 }, fx: { SOL: 100, ETH: 2500 },
    }),
    deadlineMin: 60,
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

test("createLaunch writes record, keys and image", async () => {
  const d = deps();
  const rec = await createLaunch(d, good);
  assert.match(rec.id, /^doggo-/);
  assert.equal(rec.status, "awaiting_deposit");
  assert.equal(rec.payment.deadlineAt, 1_000 + 60 * 60_000);
  assert.equal(rec.token.metadataUri, "https://ipfs.io/ipfs/metacid");
  assert.ok(rec.wallets.pumpMint.length >= 32);
  assert.ok(rec.wallets.evmMaker.startsWith("0x"));
  const keys = d.registry.keys(rec.id);
  assert.equal(keys.mint.length, 64);
  assert.ok(fs.existsSync(d.registry.imagePath(rec.id)));
  assert.equal(d.registry.get(rec.id)?.wallets.payment, rec.payment.address);
});
