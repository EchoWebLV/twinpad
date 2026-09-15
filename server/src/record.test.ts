import { test } from "node:test";
import assert from "node:assert/strict";
import { isBanned, newRecord, step } from "./record.js";

const quote = { depositSol: 0.5, depositEth: 0.02, frontSol: 1, frontEth: 0.03, devBuySol: 0.87, boostSol: 0, parityDevBuySol: 0, pumpTokens: 1, ponsEth: 0.01, ponsTokens: 1, makerCashEth: 0.02, openingFdv: 1, landing: { pump: 1, pons: 1 }, supplyPct: { pump: 1, pons: 1 }, fx: { SOL: 1, ETH: 1 } };
const mk = () => newRecord({ id: "a", now: 0, deadlineAt: 1000, devWallet: "D", chain: "sol" as const, quote,
  token: { name: "A", symbol: "A", description: "d", twitter: "", website: "", telegram: "", imageCid: "i", metadataCid: "m", metadataUri: "u" },
  wallets: { pumpMint: "M", solCreator: "C", solMaker: "K", evmLauncher: "0xL", evmMaker: "0xK", payment: "P", evmPayment: "0xP" } });

test("a launch is banned once the ban step is on its trail", () => {
  const r = mk();
  assert.equal(isBanned(r), false);
  step(r, "banned", 5, { note: "impersonation" });
  assert.equal(isBanned(r), true);
});
