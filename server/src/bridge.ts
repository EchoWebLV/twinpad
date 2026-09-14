/**
 * Relay bridge between the two pool wallets (ETH on Robinhood Chain ↔ SOL), the same
 * route TWINE's operator used (spec Appendix B). Quotes by default; sends with --confirm.
 *
 *   npm run bridge -- eth-to-sol 0.1            quote 0.1 ETH → SOL (pool → pool)
 *   npm run bridge -- sol-to-eth 2 --confirm    send 2 SOL → ETH
 */
import { Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount } from "@solana/web3.js";
import { formatEther, type Address, type Hex } from "viem";
import { config } from "./config.js";
import { connection, keypairFromBase58 } from "./solana/pump.js";
import { addressOf, publicClient, walletClient } from "./evm/pons.js";

const RELAY = "https://api.relay.link";
const CHAIN_RH = 4663;
const CHAIN_SOL = 792703809;
const ETH = "0x0000000000000000000000000000000000000000";
const SOL = "11111111111111111111111111111111";

const [dir, amountStr] = process.argv.slice(2);
const confirm = process.argv.includes("--confirm");
if (!dir || !amountStr || !["eth-to-sol", "sol-to-eth"].includes(dir)) {
  console.error("usage: bridge <eth-to-sol|sol-to-eth> <amount> [--confirm]");
  process.exit(1);
}
const amount = Number(amountStr);
if (!Number.isFinite(amount) || amount <= 0) throw new Error("bad amount");

const solKey = config.pool.solKey;
const evmKey = config.pool.evmKey;
if (!solKey || !evmKey) throw new Error("need POOL_SOL_KEY and POOL_EVM_KEY");
const solWallet = keypairFromBase58(solKey);
const evmAddr = addressOf(evmKey);

const toSol = dir === "eth-to-sol";
const body = {
  user: toSol ? evmAddr : solWallet.publicKey.toBase58(),
  recipient: toSol ? solWallet.publicKey.toBase58() : evmAddr,
  originChainId: toSol ? CHAIN_RH : CHAIN_SOL,
  destinationChainId: toSol ? CHAIN_SOL : CHAIN_RH,
  originCurrency: toSol ? ETH : SOL,
  destinationCurrency: toSol ? SOL : ETH,
  amount: toSol ? BigInt(Math.round(amount * 1e18)).toString() : Math.round(amount * 1e9).toString(),
  tradeType: "EXACT_INPUT",
  slippageTolerance: "200",
  refundOnOrigin: true,
};
const qr = await fetch(`${RELAY}/quote/v2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const quote = (await qr.json()) as any;
if (!qr.ok) throw new Error(`relay quote ${qr.status}: ${JSON.stringify(quote).slice(0, 300)}`);
const d = quote.details ?? {};
console.log(`quote ${quote.requestId ?? ""}`);
console.log(`in:  ${d.currencyIn?.amountFormatted} ${d.currencyIn?.currency?.symbol} (${d.currencyIn?.amountUsd} USD)`);
console.log(`out: ${d.currencyOut?.amountFormatted} ${d.currencyOut?.currency?.symbol} (${d.currencyOut?.amountUsd} USD)`);
console.log(`fees: relayer ${quote.fees?.relayer?.amountFormatted} ${quote.fees?.relayer?.currency?.symbol}, gas ${quote.fees?.gas?.amountFormatted}`);
console.log(`steps: ${(quote.steps ?? []).map((s: any) => `${s.id}/${s.kind}(${s.items?.length})`).join(", ")}`);
if (!confirm) {
  console.log("\ndry run — add --confirm to execute");
  process.exit(0);
}

let checkEndpoint: string | null = null;
for (const step of quote.steps ?? []) {
  for (const item of step.items ?? []) {
    if (step.kind !== "transaction") throw new Error(`unsupported step kind ${step.kind}`);
    checkEndpoint = item.check?.endpoint ?? checkEndpoint;
    const data = item.data;
    if (data.chainId === CHAIN_RH || (data.to && data.data)) {
      const pub = publicClient(config.evm.rpcUrl);
      const w = walletClient(config.evm.rpcUrl, evmKey);
      const hash = await w.sendTransaction({
        account: w.account!,
        chain: w.chain,
        to: data.to as Address,
        data: data.data as Hex,
        value: BigInt(data.value ?? 0),
      });
      console.log(`sent ${hash}`);
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      console.log(`status ${r.status}, value ${formatEther(BigInt(data.value ?? 0))} ETH`);
    } else if (data.instructions) {
      const conn: Connection = connection(config.solana.rpcUrl);
      const ixs = data.instructions.map(
        (ix: any) =>
          new TransactionInstruction({
            programId: new PublicKey(ix.programId),
            keys: ix.keys.map((k: any) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
            data: Buffer.from(ix.data, "base64"),
          }),
      );
      const luts: AddressLookupTableAccount[] = [];
      for (const a of data.addressLookupTableAddresses ?? []) {
        const r = await conn.getAddressLookupTable(new PublicKey(a));
        if (r.value) luts.push(r.value);
      }
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      const msg = new TransactionMessage({ payerKey: solWallet.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(luts);
      const tx = new VersionedTransaction(msg);
      tx.sign([solWallet]);
      const sig = await conn.sendTransaction(tx, { skipPreflight: false });
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      console.log(`sent ${sig}`);
    } else {
      throw new Error(`unrecognised step item: ${JSON.stringify(item).slice(0, 300)}`);
    }
  }
}
if (checkEndpoint) {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${RELAY}${checkEndpoint}`);
    const j = (await r.json()) as any;
    console.log(`status: ${j.status}${j.failReason ? " " + j.failReason : ""}`);
    if (j.status === "success" || j.status === "failure" || j.status === "refund") break;
    await new Promise((res) => setTimeout(res, 5000));
  }
}
