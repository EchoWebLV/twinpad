import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { formatEther, parseEther, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import type { Config } from "./config.js";
import { keypairFromBase58 } from "./solana/pump.js";
import { addressOf, walletClient } from "./evm/pons.js";
import type { Registry } from "./registry.js";

/** The operator's two pool wallets. Fronts per-coin wallets, receives deposits. Never lends below the floors. */
export class Pool {
  readonly sol: Keypair;
  readonly evm: WalletClient;
  readonly evmAddress: Address;
  readonly conn: Connection;
  readonly pub: PublicClient;

  constructor(private cfg: Config, conn: Connection, pub: PublicClient) {
    if (!cfg.pool.solKey || !cfg.pool.evmKey) throw new Error("POOL_SOL_KEY and POOL_EVM_KEY are required");
    this.sol = keypairFromBase58(cfg.pool.solKey);
    this.evm = walletClient(cfg.evm.rpcUrl, cfg.pool.evmKey);
    this.evmAddress = addressOf(cfg.pool.evmKey);
    this.conn = conn;
    this.pub = pub;
  }

  async balances() {
    const [lamports, wei] = await Promise.all([this.conn.getBalance(this.sol.publicKey), this.pub.getBalance({ address: this.evmAddress })]);
    return { sol: lamports / LAMPORTS_PER_SOL, eth: Number(formatEther(wei)) };
  }

  /** Σ fronted − repaid over records that were fronted. */
  outstanding(registry: Registry) {
    let sol = 0, eth = 0;
    for (const r of registry.list()) {
      if (!r.front.at) continue;
      // A close also sweeps launcher gas that was never part of front.eth, so clamp at zero per record.
      sol += Math.max(0, r.front.sol - r.front.repaidSol - r.front.writtenOffSol);
      eth += Math.max(0, r.front.eth - r.front.repaidEth);
      if (r.operator) { sol += r.operator.locked.lockSol; eth += r.operator.locked.lockEth; }
    }
    return { sol, eth };
  }

  async canFront(sol: number, eth: number) {
    const b = await this.balances();
    const okSol = b.sol - sol >= this.cfg.pool.minSol;
    const okEth = b.eth - eth >= this.cfg.pool.minEth;
    return { ok: okSol && okEth, balances: b, okSol, okEth };
  }

  async transferSol(to: PublicKey, sol: number): Promise<string> {
    return sendSol(this.conn, this.sol, to, sol);
  }

  async transferEth(to: Address, eth: number): Promise<string> {
    const hash = await this.evm.sendTransaction({ account: this.evm.account!, chain: this.evm.chain, to, value: parseEther(eth.toFixed(18)) });
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`eth transfer ${hash} reverted`);
    return hash;
  }

  async summary(registry: Registry) {
    const b = await this.balances();
    return {
      solana: { address: this.sol.publicKey.toBase58(), balance: b.sol, floor: this.cfg.pool.minSol },
      robinhood: { address: this.evmAddress, balance: b.eth, floor: this.cfg.pool.minEth },
      outstanding: this.outstanding(registry),
      counts: {
        live: registry.list({ status: ["live"] }).length,
        launching: registry.list({ status: ["launching"] }).length,
        queued: registry.list({ status: ["paid", "approved"] }).length,
        open: registry.list({ status: ["awaiting_deposit"] }).length,
      },
    };
  }
}

/** Plain system transfer, confirmed. */
export async function sendSol(conn: Connection, from: Keypair, to: PublicKey, sol: number): Promise<string> {
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  if (lamports <= 0) throw new Error(`transfer of ${sol} SOL is not positive`);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));
  return sendAndConfirmTransaction(conn, tx, [from], { commitment: "confirmed" });
}

/** Everything in `from` minus the tx fee, to `to`. Returns null when nothing is left to send. */
export async function sweepSol(conn: Connection, from: Keypair, to: PublicKey): Promise<{ sig: string; sol: number } | null> {
  const bal = await conn.getBalance(from.publicKey);
  const fee = 5000;
  if (bal <= fee) return null;
  const sol = (bal - fee) / LAMPORTS_PER_SOL;
  const sig = await sendSol(conn, from, to, sol);
  return { sig, sol };
}

/** Plain ETH transfer from a per-launch key, confirmed. */
export async function sendEth(pub: PublicClient, rpcUrl: string, fromKey: string, to: Address, eth: number): Promise<string> {
  const value = parseEther(eth.toFixed(18));
  if (value <= 0n) throw new Error(`transfer of ${eth} ETH is not positive`);
  const w = walletClient(rpcUrl, fromKey);
  const hash = await w.sendTransaction({ account: w.account!, chain: w.chain, to, value });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`eth transfer ${hash} reverted`);
  return hash;
}

/** Everything on `fromKey`'s address minus a gas reserve, to `to`. Null when nothing is left after gas. */
export async function sweepEth(pub: PublicClient, rpcUrl: string, fromKey: string, to: Address): Promise<{ sig: string; eth: number } | null> {
  const from = addressOf(fromKey);
  const bal = await pub.getBalance({ address: from });
  if (bal === 0n) return null;
  // EIP-1559: the cap must cover a base fee that can double between estimate and inclusion; the unused part is refunded.
  const [gas, block, fees] = await Promise.all([pub.estimateGas({ account: from, to, value: 1n }), pub.getBlock(), pub.estimateFeesPerGas()]);
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n;
  const maxFeePerGas = (block.baseFeePerGas ?? fees.maxFeePerGas ?? 0n) * 2n + maxPriorityFeePerGas;
  const reserve = gas * maxFeePerGas;
  if (bal <= reserve) return null;
  const value = bal - reserve;
  const w = walletClient(rpcUrl, fromKey);
  const hash: Hex = await w.sendTransaction({ account: w.account!, chain: w.chain, to, value, gas, maxFeePerGas, maxPriorityFeePerGas });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`eth sweep ${hash} reverted`);
  return { sig: hash, eth: Number(formatEther(value)) };
}
