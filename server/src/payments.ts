import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import type { Registry } from "./registry.js";
import { transition, step, type LaunchRecord } from "./record.js";
import { sendSol, sweepSol } from "./pool.js";

export interface Observed { sig: string; from: string; sol: number; at: number }
export interface Refund { to: string; sol: number; sig: string; reason: "foreign" | "late" }

/** Pure: fold newly observed transfers into the record. Returns refunds the caller must execute. */
export function reconcile(rec: LaunchRecord, observed: Observed[], now: number): { refunds: Refund[] } {
  const p = rec.payment;
  const seen = new Set([...p.txs, ...p.foreign].map((t) => t.tx));
  const refunds: Refund[] = [];
  for (const o of observed) {
    if (seen.has(o.sig)) continue;
    seen.add(o.sig);
    const late = o.at > p.deadlineAt;
    if (o.from !== p.expectedFrom) {
      p.foreign.push({ tx: o.sig, from: o.from, sol: o.sol, at: o.at, late });
      refunds.push({ to: o.from, sol: o.sol, sig: o.sig, reason: "foreign" });
      continue;
    }
    p.txs.push({ tx: o.sig, from: o.from, sol: o.sol, at: o.at, late });
    if (late) {
      refunds.push({ to: o.from, sol: o.sol, sig: o.sig, reason: "late" });
      continue;
    }
    p.receivedSol = round(p.receivedSol + o.sol);
  }
  if (rec.status === "awaiting_deposit" && p.receivedSol >= p.requiredSol) {
    p.paidAt = now;
    p.from = p.expectedFrom;
    p.overpaidSol = round(p.receivedSol - p.requiredSol);
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
    out.push({ sig: s.signature, from: keys.staticAccountKeys[0].toBase58(), sol: delta, at: (tx.blockTime ?? 0) * 1000 || Date.now() });
  }
  return out;
}

/** Runs every `intervalMs`: reconcile open records, refund foreign/late, expire past deadline. */
export class PaymentWatcher {
  private timer: NodeJS.Timeout | null = null;
  constructor(private conn: Connection, private registry: Registry, private intervalMs = 5000) {}

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
      const payKp = Keypair.fromSecretKey(Uint8Array.from(keys.payment));
      const known = new Set([...rec.payment.txs, ...rec.payment.foreign].map((t) => t.tx));
      const observed = await observeTransfers(this.conn, payKp.publicKey, known);
      const { refunds } = reconcile(rec, observed, now);
      for (const r of refunds) {
        try {
          const sig = await sendSol(this.conn, payKp, new PublicKey(r.to), r.sol - 0.000005);
          step(rec, "refund", now, { reason: r.reason, to: r.to, sol: r.sol, tx: sig });
        } catch (e) {
          step(rec, "refund_failed", now, { reason: r.reason, to: r.to, sol: r.sol, error: (e as Error).message });
        }
      }
      if (rec.status === "awaiting_deposit" && now > rec.payment.deadlineAt && rec.payment.receivedSol < rec.payment.requiredSol) {
        transition(rec, "expired", now);
        await refundDeposit(this.conn, this.registry, rec, now);
      }
      if (observed.length || refunds.length || rec.status !== "awaiting_deposit") this.registry.save(rec);
    }
  }
}

/** Sweep whatever sits on the payment address back to the dev wallet (reject / expire). */
export async function refundDeposit(conn: Connection, registry: Registry, rec: LaunchRecord, now: number) {
  const payKp = Keypair.fromSecretKey(Uint8Array.from(registry.keys(rec.id).payment));
  try {
    const r = await sweepSol(conn, payKp, new PublicKey(rec.devWallet));
    if (r) {
      rec.refund.sol = round(rec.refund.sol + r.sol);
      rec.refund.paidSol = rec.payment.receivedSol;
      rec.refund.txs.push(r.sig);
      step(rec, "deposit_refunded", now, { sol: r.sol, tx: r.sig });
    }
  } catch (e) {
    step(rec, "refund_failed", now, { error: (e as Error).message });
  }
  registry.save(rec);
}
