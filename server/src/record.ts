/** Launch record: the public state of one launch, same shape as TWINE V2's /api/paid entries. */
export type LaunchStatus =
  | "awaiting_deposit" | "paid" | "approved" | "launching" | "live" | "closing" | "closed" | "rejected" | "expired" | "failed";

/** Which chain the deposit is paid on. "sol": SOL to a Solana address. "eth": ETH to an EVM address on Robinhood Chain. */
export type PaymentChain = "sol" | "eth";
export const PAYMENT_UNIT: Record<PaymentChain, "SOL" | "ETH"> = { sol: "SOL", eth: "ETH" };
/** Amounts are in the deposit unit (SOL or ETH), see `payment.chain`. */
export interface PaymentTx { tx: string; from: string; amount: number; at: number; late: boolean }
export interface Step { at: number; name: string; [k: string]: unknown }

export interface Quote {
  depositSol: number;
  /** Same USD value as depositSol at the fx rate in this quote. */
  depositEth: number;
  frontSol: number;
  frontEth: number;
  devBuySol: number;
  pumpTokens: number;
  ponsEth: number;
  ponsTokens: number;
  makerCashEth: number;
  /** Deployer's extra dev buy on pump.fun, paid on top of the deposit (SOL deposits only). */
  boostSol: number;
  /** Gross dev buy that lands pump.fun on the Pons floor (phantom ETH × ETH price). The pool never auto-sizes above it. */
  parityDevBuySol: number;
  openingFdv: number;
  landing: { pump: number; pons: number };
  supplyPct: { pump: number; pons: number };
  fx: { SOL: number; ETH: number };
}

/** Exit policy state for one live coin: the timer, the verdict, and what the close recovered. */
export interface Retire {
  /** When the timer evaluates outside interest (launchedAt + RETIRE_AFTER_MIN). */
  decideAt: number;
  policy: { afterMin: number; minBuyers: number; minUsd: number; selldownMin: number };
  /** Operator said keep: the timer never closes this coin. */
  keep: boolean;
  evaluated: { at: number; outsideBuyers: number; outsideUsd: number; verdict: "keep" | "full" | "selldown" } | null;
  /** Selldown mode: sell clips above entry until this time, then close fully. */
  selldownUntil: number | null;
  mode: "full" | "selldown" | null;
  reason: string | null;
  startedAt: number | null;
  closedAt: number | null;
  sold: { pumpTokens: number; ponsTokens: number; txs: string[] };
  swept: { sol: number; eth: number; txs: string[] };
  error: string | null;
}

export function newRetire(launchedAt: number, policy: Retire["policy"]): Retire {
  return {
    decideAt: launchedAt + policy.afterMin * 60_000, policy, keep: false, evaluated: null, selldownUntil: null,
    mode: null, reason: null, startedAt: null, closedAt: null, sold: { pumpTokens: 0, ponsTokens: 0, txs: [] }, swept: { sol: 0, eth: 0, txs: [] }, error: null,
  };
}

export interface TokenMeta {
  name: string; symbol: string; description: string; twitter: string; website: string; telegram: string;
  imageCid: string; metadataCid: string; metadataUri: string;
}

export interface LaunchRecord {
  id: string;
  createdAt: number;
  status: LaunchStatus;
  /** Operator switch: keep this launch and its coin out of every public list. Admin routes still see it. */
  hidden: boolean;
  token: TokenMeta;
  devWallet: string;
  /** Deployer boost (SOL) added to the dev buy; refunded pro-rata from what the close recovers. */
  boostSol: number;
  devShareBps: number;
  devShareBpsFunded: number;
  wallets: {
    pumpMint: string; solCreator: string; solMaker: string; evmLauncher: string; evmMaker: string; payment: string; evmPayment: string;
    /** Operator launches only: the locked-allocation wallets (bought at open, never sold, untouched at close). */
    solLock?: string; evmLock?: string;
  };
  payment: {
    chain: PaymentChain; unit: "SOL" | "ETH";
    /** Payment address on `chain`. */
    address: string; required: number; received: number; paidAt: number | null; from: string | null;
    expectedFrom: string; overpaid: number; deadlineAt: number; toPoolTx: string | null; txs: PaymentTx[]; foreign: PaymentTx[];
    /** ETH only: tx hashes submitted by the payer, verified by the watcher over RPC. */
    claimed: string[];
  };
  approval: { status: "pending" | "approved" | "rejected"; at: number | null; note: string | null; auto: boolean };
  /** sol/eth: what went to the per-coin wallets (sol includes boostSol; eth grows with top-ups). repaid*: swept back to the pool so far. */
  front: {
    sol: number; eth: number; at: number | null; txSol: string | null; txRhLauncher: string | null; txRhMaker: string | null;
    repaidSol: number; repaidEth: number; writtenOffSol: number;
    /** ETH the pool sent the maker after launch because Pons demand drained it (≤ MAX_TOPUP_ETH_PER_COIN). */
    topupEth: number;
    topupSol: number;
    /** Creator fees claimed while live: pump.fun creator vault (SOL) and the Pons creator tax escrow (ETH). */
    feesSol: number; feesEth: number;
    /** When repaid ≥ fronted on both chains: the front is retired, what is left in the coin is profit. */
    retiredAt: number | null;
  };
  seed: { pumpTokens: number; ponsTokens: number; openingFdv: number; at: number } | null;
  launch: {
    startedAt: number | null; steps: Step[]; salt: string | null; pumpMint: string | null; ponsToken: string | null; ponsCurve: string | null;
    launchedAt: number | null; txs: Record<string, string>; error: string | null;
    /** Automatic retries after a failed launch (LAUNCH_AUTO_RETRIES). */
    retries: number;
  };
  /** In the deposit unit. */
  refund: { amount: number; paid: number; txs: string[] };
  reserve: null;
  waterfall: null;
  retire: Retire | null;
  quote: Quote;
  /** Set on launches the operator made from the hidden route (no deposit, explicit sizing, locked allocation). Null on paid launches. */
  operator: OperatorLaunch | null;
}

/**
 * The operator's own launch: the pool buys a locked share of the supply on both chains at open (never sold, left alone at
 * close), the maker opens with an explicit pump.fun bundle buy and Pons buy, and keeps extra cash per side. The lock money is
 * not part of `front` (the maker never trades it); `locked` records what the pool sent the lock wallets and what they hold.
 */
export interface OperatorLaunch {
  /** Share of the supply (percent) bought into the lock wallet on each chain, inside the pump.fun bundle / right after the Pons launch. */
  lockPct: number;
  /** The maker's pump.fun opening buy (gross SOL, sent in the create bundle). */
  bundleSol: number;
  /** The maker's Pons opening buy (gross ETH, right after the lock buy). */
  ponsEth: number;
  /** Extra quote kept in each maker wallet on top of the gas budget / maker cash; the recovery sweep leaves it alone. */
  cashSol: number; cashEth: number;
  /** Per-coin loss guard (USD) for this coin; null = MAX_LOSS_USD_PER_COIN. */
  maxLossUsd: number | null;
  /** What the pool sent the lock wallets (funding, incl. gas/rent margin) and what they hold once launched. */
  /** What the pool sends each lock wallet and the gross pump.fun buy the Solana lock wallet places. */
  lock: { fundSol: number; fundEth: number; buySol: number };
  locked: { lockSol: number; lockEth: number; pumpTokens: number; ponsTokens: number; txSol: string | null; txEth: string | null };
  /** true = the operator pasted the dev wallet (lock) and buyer wallets; they pay their own buys and the pool fronts nothing to them. */
  selfFunded: boolean;
  /** The pasted wallets (addresses + amounts only; keys live in keys.json) and each buyer's checkpointed buys. */
  bundle: { dev: { sol: string; evm: string }; buyers: BundleBuyer[] } | null;
}

/** One pasted buyer wallet: buys `buySol` in the pump.fun bundle from `sol` and `buyEth` on Pons from `evm` (null = not on that chain). */
export interface BundleBuyer { sol: string | null; evm: string | null; buySol: number; buyEth: number; txSol: string | null; txEth: string | null }

/** Secret keys for one launch. Written 0600, never served. */
/** solMaker is absent on records made before the creator/maker split; those coins keep trading from solCreator. */
export interface LaunchKeys {
  mint: number[]; solCreator: number[]; solMaker?: number[]; payment: number[]; evmLauncher: string; evmMaker: string; evmPayment: string; solLock?: number[]; evmLock?: string;
  /** Operator bundle buyers, same order as `operator.bundle.buyers`. */
  buyers?: { sol?: number[]; evm?: string }[];
}

export interface NewRecordInput {
  id: string; token: TokenMeta; devWallet: string; chain: PaymentChain; wallets: LaunchRecord["wallets"]; quote: Quote; deadlineAt: number; now: number;
  operator?: OperatorLaunch | null;
}

export function newRecord(i: NewRecordInput): LaunchRecord {
  return {
    id: i.id,
    createdAt: i.now,
    status: "awaiting_deposit",
    hidden: false,
    token: i.token,
    devWallet: i.devWallet,
    boostSol: i.quote.boostSol,
    devShareBps: 0,
    devShareBpsFunded: 5000,
    wallets: i.wallets,
    payment: {
      chain: i.chain, unit: PAYMENT_UNIT[i.chain],
      address: i.chain === "eth" ? i.wallets.evmPayment : i.wallets.payment,
      required: i.chain === "eth" ? i.quote.depositEth : round6(i.quote.depositSol + i.quote.boostSol), received: 0, paidAt: null, from: null,
      expectedFrom: i.devWallet, overpaid: 0, deadlineAt: i.deadlineAt, toPoolTx: null, txs: [], foreign: [], claimed: [],
    },
    approval: { status: "pending", at: null, note: null, auto: false },
    front: {
      sol: round6(i.quote.frontSol + i.quote.boostSol), eth: i.quote.frontEth, at: null, txSol: null, txRhLauncher: null, txRhMaker: null,
      repaidSol: 0, repaidEth: 0, writtenOffSol: 0, topupEth: 0, topupSol: 0, feesSol: 0, feesEth: 0, retiredAt: null,
    },
    seed: null,
    launch: { startedAt: null, steps: [{ at: i.now, name: "created" }], salt: null, pumpMint: null, ponsToken: null, ponsCurve: null, launchedAt: null, txs: {}, error: null, retries: 0 },
    refund: { amount: 0, paid: 0, txs: [] },
    reserve: null,
    waterfall: null,
    retire: null,
    quote: i.quote,
    operator: i.operator ?? null,
  };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

const ALLOWED: Record<LaunchStatus, LaunchStatus[]> = {
  awaiting_deposit: ["paid", "expired", "rejected"],
  paid: ["approved", "rejected"],
  approved: ["launching", "rejected", "closing"], // closing: a ban after the front was funded sweeps the per-coin wallets back
  launching: ["live", "failed"],
  live: ["closing"],
  closing: ["closed"],
  closed: [],
  rejected: [],
  expired: [],
  failed: ["approved", "closing"],
};

export function transition(rec: LaunchRecord, to: LaunchStatus, now: number, extra: Record<string, unknown> = {}) {
  if (!ALLOWED[rec.status].includes(to)) throw new Error(`illegal transition ${rec.status} → ${to} (${rec.id})`);
  rec.status = to;
  rec.launch.steps.push({ at: now, name: `status:${to}`, ...extra });
}

export function step(rec: LaunchRecord, name: string, now: number, extra: Record<string, unknown> = {}) {
  rec.launch.steps.push({ at: now, name, ...extra });
}

/** Banned launches stay in the registry (refunds, audit trail) but leave every public list. */
export const isBanned = (rec: LaunchRecord) => rec.launch.steps.some((s) => s.name === "banned");

/** What the API serves: the record as stored (it holds public keys only). Exists so the boundary is explicit. */
export function publicRecord(rec: LaunchRecord): LaunchRecord {
  return rec;
}

/** Records written before ETH deposits existed: SOL-only shape with requiredSol/receivedSol/refund.sol. */
export function migrateRecord(raw: Record<string, unknown>): LaunchRecord {
  const p = raw.payment as Record<string, unknown>;
  if (p && !("chain" in p)) {
    const tx = (t: Record<string, unknown>) => ({ ...t, amount: t.amount ?? t.sol });
    raw.payment = {
      chain: "sol", unit: "SOL", address: p.address, required: p.requiredSol, received: p.receivedSol, paidAt: p.paidAt, from: p.from,
      expectedFrom: p.expectedFrom, overpaid: p.overpaidSol, deadlineAt: p.deadlineAt, toPoolTx: p.toPoolTx,
      txs: ((p.txs as Record<string, unknown>[]) ?? []).map(tx), foreign: ((p.foreign as Record<string, unknown>[]) ?? []).map(tx), claimed: [],
    };
    const r = raw.refund as Record<string, unknown>;
    raw.refund = { amount: r?.amount ?? r?.sol ?? 0, paid: r?.paid ?? r?.paidSol ?? 0, txs: r?.txs ?? [] };
    const w = raw.wallets as Record<string, unknown>;
    w.evmPayment ??= "";
    w.solMaker ??= w.solCreator;
    const q = raw.quote as Record<string, unknown>;
    q.depositEth ??= 0;
  }
  const f = raw.front as Record<string, unknown> | undefined;
  if (f) { f.repaidEth ??= 0; f.topupEth ??= 0; f.topupSol ??= 0; f.feesSol ??= 0; f.feesEth ??= 0; f.retiredAt ??= null; }
  raw.boostSol ??= 0;
  const q = raw.quote as Record<string, unknown> | undefined;
  if (q) { q.boostSol ??= 0; q.parityDevBuySol ??= 0; }
  const l = raw.launch as Record<string, unknown> | undefined;
  if (l) l.retries ??= 0;
  raw.hidden ??= false;
  raw.retire ??= null;
  raw.operator ??= null;
  const op = raw.operator as Record<string, unknown> | null;
  if (op) { op.selfFunded ??= false; op.bundle ??= null; }
  return raw as unknown as LaunchRecord;
}

export const OPEN_STATUSES: LaunchStatus[] = ["awaiting_deposit", "paid", "approved", "launching", "failed"];
