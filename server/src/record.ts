/** Launch record: the public state of one launch, same shape as TWINE V2's /api/paid entries. */
export type LaunchStatus =
  | "awaiting_deposit" | "paid" | "approved" | "launching" | "live" | "rejected" | "expired" | "failed";

export interface PaymentTx { tx: string; from: string; sol: number; at: number; late: boolean }
export interface Step { at: number; name: string; [k: string]: unknown }

export interface Quote {
  depositSol: number;
  frontSol: number;
  frontEth: number;
  devBuySol: number;
  pumpTokens: number;
  ponsEth: number;
  ponsTokens: number;
  makerCashEth: number;
  openingFdv: number;
  landing: { pump: number; pons: number };
  supplyPct: { pump: number; pons: number };
  fx: { SOL: number; ETH: number };
}

export interface TokenMeta {
  name: string; symbol: string; description: string; twitter: string; website: string; telegram: string;
  imageCid: string; metadataCid: string; metadataUri: string;
}

export interface LaunchRecord {
  id: string;
  createdAt: number;
  status: LaunchStatus;
  token: TokenMeta;
  devWallet: string;
  devShareBps: number;
  devShareBpsFunded: number;
  wallets: { pumpMint: string; solCreator: string; evmLauncher: string; evmMaker: string; payment: string };
  payment: {
    address: string; requiredSol: number; receivedSol: number; paidAt: number | null; from: string | null;
    expectedFrom: string; overpaidSol: number; deadlineAt: number; toPoolTx: string | null; txs: PaymentTx[]; foreign: PaymentTx[];
  };
  approval: { status: "pending" | "approved" | "rejected"; at: number | null; note: string | null; auto: boolean };
  front: { sol: number; eth: number; at: number | null; txSol: string | null; txRhLauncher: string | null; txRhMaker: string | null; repaidSol: number; writtenOffSol: number };
  seed: { pumpTokens: number; ponsTokens: number; openingFdv: number; at: number } | null;
  launch: {
    startedAt: number | null; steps: Step[]; salt: string | null; pumpMint: string | null; ponsToken: string | null; ponsCurve: string | null;
    launchedAt: number | null; txs: Record<string, string>; error: string | null;
  };
  refund: { sol: number; paidSol: number; txs: string[] };
  reserve: null;
  waterfall: null;
  retire: null;
  quote: Quote;
}

/** Secret keys for one launch. Written 0600, never served. */
export interface LaunchKeys { mint: number[]; solCreator: number[]; payment: number[]; evmLauncher: string; evmMaker: string }

export interface NewRecordInput {
  id: string; token: TokenMeta; devWallet: string; wallets: LaunchRecord["wallets"]; quote: Quote; deadlineAt: number; now: number;
}

export function newRecord(i: NewRecordInput): LaunchRecord {
  return {
    id: i.id,
    createdAt: i.now,
    status: "awaiting_deposit",
    token: i.token,
    devWallet: i.devWallet,
    devShareBps: 0,
    devShareBpsFunded: 5000,
    wallets: i.wallets,
    payment: {
      address: i.wallets.payment, requiredSol: i.quote.depositSol, receivedSol: 0, paidAt: null, from: null,
      expectedFrom: i.devWallet, overpaidSol: 0, deadlineAt: i.deadlineAt, toPoolTx: null, txs: [], foreign: [],
    },
    approval: { status: "pending", at: null, note: null, auto: false },
    front: { sol: i.quote.frontSol, eth: i.quote.frontEth, at: null, txSol: null, txRhLauncher: null, txRhMaker: null, repaidSol: 0, writtenOffSol: 0 },
    seed: null,
    launch: { startedAt: null, steps: [{ at: i.now, name: "created" }], salt: null, pumpMint: null, ponsToken: null, ponsCurve: null, launchedAt: null, txs: {}, error: null },
    refund: { sol: 0, paidSol: 0, txs: [] },
    reserve: null,
    waterfall: null,
    retire: null,
    quote: i.quote,
  };
}

const ALLOWED: Record<LaunchStatus, LaunchStatus[]> = {
  awaiting_deposit: ["paid", "expired", "rejected"],
  paid: ["approved", "rejected"],
  approved: ["launching", "rejected"],
  launching: ["live", "failed"],
  live: [],
  rejected: [],
  expired: [],
  failed: ["approved"],
};

export function transition(rec: LaunchRecord, to: LaunchStatus, now: number, extra: Record<string, unknown> = {}) {
  if (!ALLOWED[rec.status].includes(to)) throw new Error(`illegal transition ${rec.status} → ${to} (${rec.id})`);
  rec.status = to;
  rec.launch.steps.push({ at: now, name: `status:${to}`, ...extra });
}

export function step(rec: LaunchRecord, name: string, now: number, extra: Record<string, unknown> = {}) {
  rec.launch.steps.push({ at: now, name, ...extra });
}

/** What the API serves: the record as stored (it holds public keys only). Exists so the boundary is explicit. */
export function publicRecord(rec: LaunchRecord): LaunchRecord {
  return rec;
}

export const OPEN_STATUSES: LaunchStatus[] = ["awaiting_deposit", "paid", "approved", "launching", "failed"];
