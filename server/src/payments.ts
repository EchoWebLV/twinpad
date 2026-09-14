import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { formatEther, getAddress, type Address, type Hex, type PublicClient } from "viem";
import type { Registry } from "./registry.js";
import { transition, step, type LaunchRecord } from "./record.js";
import { sendEth, sendSol, sweepEth, sweepSol } from "./pool.js";
import { addressOf } from "./evm/pons.js";

/** One incoming transfer to the payment address, in the deposit unit. */
export interface Observed { sig: string; from: string; amount: number; at: number }
export interface Refund { to: string; amount: number; sig: string; reason: "foreign" | "late" }

/** Pure: fold newly observed transfers into the record. Returns refunds the caller must execute. */
export function reconcile(rec: LaunchRecord, observed: Observed[], now: number): { refunds: Refund[] } {
  const p = rec.payment;
  const seen = new Set([...p.txs, ...p.foreign].map((t) => t.tx));
  const refunds: Refund[] = [];
  const same = (a: string, b: string) => (p.chain === "eth" ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (const o of observed) {
    if (seen.has(o.sig)) continue;
    seen.add(o.sig);
    const late = o.at > p.deadlineAt;
    if (!same(o.from, p.expectedFrom)) {
      p.foreign.push({ tx: o.sig, from: o.from, amount: o.amount, at: o.at, late });
      refunds.push({ to: o.from, amount: o.amount, sig: o.sig, reason: "foreign" });
      continue;
    }
    p.txs.push({ tx: o.sig, from: o.from, amount: o.amount, at: o.at, late });
    if (late) {
      refunds.push({ to: o.from, amount: o.amount, sig: o.sig, reason: "late" });
      continue;
    }
    p.received = round(p.received + o.amount);
  }
  if (rec.status === "awaiting_deposit" && p.received >= p.required) {
    p.paidAt = now;
    p.from = p.expectedFrom;
    p.overpaid = round(p.received - p.required);
    transition(rec, "paid", now);
  }
  return { refunds };
}

const round = (n: number) => Math.round(n * 1e9) / 1e9;

/** Incoming SOL transfers to `address`: fee payer of each tx and the address's balance delta. */
export async function observeTransfers(conn: Connection, address: PublicKey, known: Set<string>): Promise<Observed[]> {
  const sigs = await conn.getSignaturesForAddress(address, { limit: 25 }, "confirmed");
  const out: Observed[] = [];
  for (const s of sigs) {
    if (known.has(s.signature) || s.err) continue;
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx || !tx.meta) continue;
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
    const idx = keys.staticAccountKeys.findIndex((k) => k.equals(address));
    if (idx < 0) continue;
    const delta = (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / LAMPORTS_PER_SOL;
    if (delta <= 0) continue;
    out.push({ sig: s.signature, from: keys.staticAccountKeys[0].toBase58(), amount: delta, at: (tx.blockTime ?? 0) * 1000 || Date.now() });
  }
  return out;
}

export const ETH_TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * Robinhood Chain has no cheap "transfers to address" query (≈10 blocks/s, explorer API behind a bot wall),
 * so ETH deposits are credited from tx hashes the payer submits. Each claimed hash is checked over RPC:
 * mined, succeeded, sent to the payment address, carries ETH. Hashes that are not mined yet stay claimed.
 */
export async function observeClaims(pub: PublicClient, address: string, claimed: string[], known: Set<string>): Promise<{ observed: Observed[]; drop: string[] }> {
  const observed: Observed[] = [];
  const drop: string[] = [];
  const to = getAddress(address);
  for (const hash of claimed) {
    if (known.has(hash)) { drop.push(hash); continue; }
    if (!ETH_TX_HASH.test(hash)) { drop.push(hash); continue; }
    const receipt = await pub.getTransactionReceipt({ hash: hash as Hex }).catch(() => null);
    if (!receipt) continue; // not mined yet (or unknown): try again next tick
    const tx = await pub.getTransaction({ hash: hash as Hex });
    const ok = receipt.status === "success" && tx.to && getAddress(tx.to) === to && tx.value > 0n;
    if (!ok) { drop.push(hash); continue; }
    const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
    observed.push({ sig: hash, from: getAddress(tx.from), amount: Number(formatEther(tx.value)), at: Number(block.timestamp) * 1000 });
    drop.push(hash);
  }
  return { observed, drop };
}

export interface Chains { conn: Connection; pub: PublicClient; rpcUrl: string }

/** Runs every `intervalMs`: reconcile open records, refund foreign/late, expire past deadline. */
export class PaymentWatcher {
  private timer: NodeJS.Timeout | null = null;
  constructor(private chains: Chains, private registry: Registry, private intervalMs = 5000) {}

  start() {
    const loop = async () => {
      try {
        await this.tick();
      } catch (e) {
        console.error("[payments]", (e as Error).message);
      }
      this.timer = setTimeout(loop, this.intervalMs);
    };
    void loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  async tick(now = Date.now()) {
    for (const rec of this.registry.list({ status: ["awaiting_deposit"] })) {
      const keys = this.registry.keys(rec.id);
      const known = new Set([...rec.payment.txs, ...rec.payment.foreign].map((t) => t.tx));
      let observed: Observed[];
      let touched = false;
      if (rec.payment.chain === "eth") {
        const r = await observeClaims(this.chains.pub, rec.payment.address, rec.payment.claimed, known);
        observed = r.observed;
        if (r.drop.length) { rec.payment.claimed = rec.payment.claimed.filter((h) => !r.drop.includes(h)); touched = true; }
      } else {
        const payKp = Keypair.fromSecretKey(Uint8Array.from(keys.payment));
        observed = await observeTransfers(this.chains.conn, payKp.publicKey, known);
      }
      const { refunds } = reconcile(rec, observed, now);
      for (const r of refunds) {
        try {
          const sig = rec.payment.chain === "eth"
            ? await refundEth(this.chains, keys.evmPayment, r.to as Address, r.amount)
            : await sendSol(this.chains.conn, Keypair.fromSecretKey(Uint8Array.from(keys.payment)), new PublicKey(r.to), r.amount - 0.000005);
          step(rec, "refund", now, { reason: r.reason, to: r.to, amount: r.amount, unit: rec.payment.unit, tx: sig });
        } catch (e) {
          step(rec, "refund_failed", now, { reason: r.reason, to: r.to, amount: r.amount, unit: rec.payment.unit, error: (e as Error).message });
        }
      }
      if (rec.status === "awaiting_deposit" && now > rec.payment.deadlineAt && rec.payment.received < rec.payment.required) {
        transition(rec, "expired", now);
        await refundDeposit(this.chains, this.registry, rec, now);
      }
      if (touched || observed.length || refunds.length || rec.status !== "awaiting_deposit") this.registry.save(rec);
    }
  }
}

/** Refund one ETH payment minus the gas it costs to send it. */
async function refundEth(chains: Chains, key: string, to: Address, amount: number): Promise<string> {
  const from = addressOf(key);
  const [gas, gasPrice] = await Promise.all([chains.pub.estimateGas({ account: from, to, value: 1n }), chains.pub.getGasPrice()]);
  const fee = Number(formatEther((gas * gasPrice * 3n) / 2n));
  return sendEth(chains.pub, chains.rpcUrl, key, to, amount - fee);
}

/** Sweep whatever sits on the payment address back to the dev wallet (reject / expire). */
export async function refundDeposit(chains: Chains, registry: Registry, rec: LaunchRecord, now: number) {
  const keys = registry.keys(rec.id);
  try {
    const r = rec.payment.chain === "eth"
      ? await sweepEth(chains.pub, chains.rpcUrl, keys.evmPayment, getAddress(rec.devWallet)).then((x) => x && { sig: x.sig, amount: x.eth })
      : await sweepSol(chains.conn, Keypair.fromSecretKey(Uint8Array.from(keys.payment)), new PublicKey(rec.devWallet)).then((x) => x && { sig: x.sig, amount: x.sol });
    if (r) {
      rec.refund.amount = round(rec.refund.amount + r.amount);
      rec.refund.paid = rec.payment.received;
      rec.refund.txs.push(r.sig);
      step(rec, "deposit_refunded", now, { amount: r.amount, unit: rec.payment.unit, tx: r.sig });
    }
  } catch (e) {
    step(rec, "refund_failed", now, { error: (e as Error).message });
  }
  registry.save(rec);
}

/**
 * Refund from the pool wallets: for a deposit that already moved to the pool (`payment.toPoolTx`), or any amount
 * the operator owes an address (an unclaimed transfer the sweep picked up). Defaults: the payer, what they paid
 * minus what was refunded already. Records `deposit_refunded` and bumps `refund`.
 */
export async function refundFromPool(
  pool: { transferSol(to: PublicKey, sol: number): Promise<string>; transferEth(to: Address, eth: number): Promise<string> },
  registry: Registry, rec: LaunchRecord, now: number, opts: { to?: string; amount?: number; reason?: string } = {},
): Promise<{ to: string; amount: number; sig: string }> {
  const to = opts.to ?? rec.payment.from ?? rec.devWallet;
  const amount = Math.round((opts.amount ?? rec.payment.received - rec.refund.amount) * 1e9) / 1e9;
  if (!to) throw new Error("no address to refund to");
  if (!(amount > 0)) throw new Error(`nothing to refund (paid ${rec.payment.received}, refunded ${rec.refund.amount})`);
  const sig = rec.payment.chain === "eth"
    ? await pool.transferEth(getAddress(to), amount)
    : await pool.transferSol(new PublicKey(to), amount);
  const payer = (rec.payment.from ?? rec.devWallet).toLowerCase();
  if (to.toLowerCase() === payer) {
    rec.refund.amount = Math.round((rec.refund.amount + amount) * 1e9) / 1e9;
    rec.refund.paid = rec.payment.received;
    rec.refund.txs.push(sig);
  }
  step(rec, to.toLowerCase() === payer ? "deposit_refunded" : "excess_refunded", now, { amount, unit: rec.payment.unit, to, tx: sig, from: "pool", reason: opts.reason ?? "admin" });
  registry.save(rec);
  return { to, amount, sig };
}
