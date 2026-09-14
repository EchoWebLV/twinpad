import { PublicKey } from "@solana/web3.js";
import { createFeeSharingConfigIx, updateFeeSharesIx } from "../../src/solana/fees.ts";
import { connection } from "../../src/solana/pump.ts";
import { publicClient, PONS, readLaunch } from "../../src/evm/pons.ts";
import { poolKey, poolId, encodeV4ExactInSingle, readSlot0 } from "../../src/evm/v4.ts";
import { keccak256, encodeAbiParameters, parseAbi, parseEther } from "viem";

const MINT = new PublicKey("CNWxmoBSQZo2Sgp5KSAK5m9FwSqDbXQRP4CNMuoe78Gm");
const CREATOR = new PublicKey("2HfMe7agaqDBbdNT8LLK3xEAyLe4VApXePcENV5RnDu5");
const BOT = new PublicKey("9iMztAwXeu4c8Qr4yFs1KM13xFbgFRCz6n1oPqjykBUR");
const conn = connection(process.env.RPC_URL!);
async function onchain(sig: string) {
  const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
  const msg = t!.transaction.message;
  const keys = msg.getAccountKeys({ accountKeysFromLookups: t!.meta?.loadedAddresses }).staticAccountKeys.map((k) => k.toBase58());
  for (const ix of msg.compiledInstructions) {
    if (keys[ix.programIdIndex].startsWith("pfee")) return { keys: ix.accountKeyIndexes.map((i) => keys[i]), data: Buffer.from(ix.data).toString("hex") };
  }
  throw new Error("no pfee ix");
}
const c = await onchain("s5pQUhFSPfd7Mx5D7e7H5o6L8wFsgV4wQ7zPifuxzRRztAuacNm7o89i3V5t4dyppW8283a4WPnwVjvKmShkY8w");
const mine = createFeeSharingConfigIx(CREATOR, MINT);
const mineKeys = mine.keys.map((k) => k.pubkey.toBase58());
console.log("create_fee_sharing_config keys match:", JSON.stringify(mineKeys) === JSON.stringify(c.keys), "data match:", mine.data.toString("hex") === c.data);
if (JSON.stringify(mineKeys) !== JSON.stringify(c.keys)) console.log(mineKeys, c.keys);
const u = await onchain("3jE127wcGUurF81L21wakhykKDpEWs5c4UrBofheZomUB6sGEXveamVpAMuzizoQYtVXkMwRA2JAVfNRCB6yU6Lp");
const mu = updateFeeSharesIx(CREATOR, MINT, [{ address: BOT, shareBps: 10000 }], [CREATOR]);
const muKeys = mu.keys.map((k) => k.pubkey.toBase58());
console.log("update_fee_shares keys match:", JSON.stringify(muKeys) === JSON.stringify(u.keys), "data match:", mu.data.toString("hex") === u.data);
if (JSON.stringify(muKeys) !== JSON.stringify(u.keys)) console.log(muKeys, u.keys);
if (mu.data.toString("hex") !== u.data) console.log(mu.data.toString("hex"), u.data);

// ---- EVM: v4 swap encoding, simulated from the TWINE bot (funded) ----
const pub = publicClient("https://rpc.ordofi.network");
const TOKEN = "0xe27501d787d647CC82a5B4a7Eafd5750386F1B77" as const;
const l = await readLaunch(pub, TOKEN);
const key = poolKey(TOKEN, Number(l.tickSpacing), l.pairToken);
console.log("poolId", poolId(key));
const s = await readSlot0(pub, key);
const liqSlot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId(key), 6n]));
const liq = await pub.readContract({ address: PONS.poolManager, abi: parseAbi(["function extsload(bytes32) view returns (bytes32)"]), functionName: "extsload", args: [("0x" + (BigInt(liqSlot) + 3n).toString(16).padStart(64, "0")) as `0x${string}`] });
const L = BigInt(liq) & ((1n << 128n) - 1n);
const sqrtP = Number(s.sqrtPriceX96) / 2 ** 96;
console.log("liquidity", L.toString(), "≈ETH depth L/sqrtP", Number(L) / sqrtP / 1e18, "token depth L*sqrtP", (Number(L) * sqrtP) / 1e18);
const tx = encodeV4ExactInSingle(key, true, parseEther("0.01"), 0n, Math.floor(Date.now() / 1000) + 300);
const BOTEVM = "0x0cA689eC5898b1BCBD0aeC0D28490732f0cf7528";
try {
  const r = await pub.call({ account: BOTEVM, to: tx.to, data: tx.data, value: tx.value });
  console.log("v4 buy simulation OK", r.data?.slice(0, 20));
  const gas = await pub.estimateGas({ account: BOTEVM, to: tx.to, data: tx.data, value: tx.value });
  console.log("gas", gas.toString());
} catch (e) { console.log("v4 buy simulation FAILED:", (e as Error).message.split("\n").slice(0, 4).join(" | ")); }
// sell simulation (bot holds TWINE and, if it trades via this router, has permit2 set)
const tx2 = encodeV4ExactInSingle(key, false, parseEther("1000"), 0n, Math.floor(Date.now() / 1000) + 300);
try {
  await pub.call({ account: BOTEVM, to: tx2.to, data: tx2.data, value: 0n });
  console.log("v4 sell simulation OK");
} catch (e) { console.log("v4 sell simulation FAILED:", (e as Error).message.split("\n").slice(0, 4).join(" | ")); }
