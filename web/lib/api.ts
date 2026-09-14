export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

/** Reads give up after 15 s so one stalled request cannot hold a page's whole refresh. */
export async function getJson<T>(path: string, admin?: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { cache: "no-store", signal: AbortSignal.timeout(15_000), headers: admin ? { "x-admin-token": admin } : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j as T;
}

export async function postJson<T>(path: string, body: unknown, admin?: string): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(admin ? { "x-admin-token": admin } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j as T;
}

export interface Quote {
  depositSol: number; depositEth: number; frontSol: number; frontEth: number; devBuySol: number; boostSol: number; parityDevBuySol: number; ponsEth: number; openingFdv: number;
  landing: { pump: number; pons: number }; supplyPct: { pump: number; pons: number }; fx: { SOL: number; ETH: number };
}
export interface Step { at: number; name: string; [k: string]: unknown }
export interface Launch {
  id: string; createdAt: number; status: string;
  token: { name: string; symbol: string; description: string; imageCid: string; twitter: string; website: string; telegram: string };
  devWallet: string;
  boostSol: number;
  wallets: { pumpMint: string; solCreator: string; solMaker: string; evmLauncher: string; evmMaker: string; payment: string; evmPayment: string; solLock?: string; evmLock?: string };
  payment: {
    chain: "sol" | "eth"; unit: "SOL" | "ETH"; address: string; required: number; received: number; paidAt: number | null; deadlineAt: number;
    txs: { tx: string; amount: number; late: boolean }[]; foreign: { tx: string; amount: number }[]; claimed: string[];
  };
  approval: { status: string; at: number | null; note: string | null; auto: boolean };
  front: { sol: number; eth: number; at: number | null; repaidSol: number; repaidEth: number; topupEth: number; topupSol: number; feesSol: number; feesEth: number; retiredAt: number | null };
  launch: { steps: Step[]; pumpMint: string | null; ponsToken: string | null; error: string | null; retries: number };
  refund: { amount: number; paid: number; txs: string[] };
  retire: {
    decideAt: number; policy: { afterMin: number; minBuyers: number; minUsd: number; selldownMin: number }; keep: boolean;
    evaluated: { at: number; outsideBuyers: number; outsideUsd: number; verdict: "keep" | "full" | "selldown" } | null;
    selldownUntil: number | null; mode: "full" | "selldown" | null; reason: string | null; closedAt: number | null;
    sold: { pumpTokens: number; ponsTokens: number; txs: string[] }; swept: { sol: number; eth: number; txs: string[] }; error: string | null;
  } | null;
  quote: Quote;
  /** Operator launches only: the locked allocation and the peg's chosen opening size. */
  operator?: OperatorLaunch | null;
}
export interface OperatorLaunch {
  lockPct: number; bundleSol: number; ponsEth: number; cashSol: number; cashEth: number; maxLossUsd: number | null;
  lock: { fundSol: number; fundEth: number; buySol: number };
  locked: { lockSol: number; lockEth: number; pumpTokens: number; ponsTokens: number; txSol: string | null; txEth: string | null };
  selfFunded: boolean;
  bundle: { dev: { sol: string; evm: string }; buyers: { sol: string | null; evm: string | null; buySol: number; buyEth: number; txSol: string | null; txEth: string | null }[] } | null;
}
export interface OperatorShape {
  lock: { pct: number; tokens: number; sol: number; solGross: number; eth: number; ethGross: number; fundSol: number; fundEth: number };
  pump: { devBuySol: number; tokens: number; supplyPct: number; fdv: number; makerFrontSol: number };
  pons: { eth: number; tokens: number; supplyPct: number; fdv: number; makerFrontEth: number; parityEth: number };
  buyers: { count: number; sol: number; eth: number; pumpTokens: number; ponsTokens: number; pumpSupplyPct: number; ponsSupplyPct: number; pumpFdv: number; ponsFdv: number };
  pool: { sol: number; eth: number };
  selfFunded: boolean;
  gapPct: number;
  fx: { SOL: number; ETH: number };
}
export interface OperatorQuoteResp {
  shape: OperatorShape;
  pool: { balances: { sol: number; eth: number }; free: { sol: number; eth: number }; ok: boolean; floors: { sol: number; eth: number } };
}
export interface WalletCheck { address: string; balance: number; need: number; ok: boolean }
export interface BundleCheckResp extends OperatorQuoteResp {
  wallets: { ok: boolean; rows: { label: string; sol: WalletCheck | null; evm: WalletCheck | null }[]; short: string[] } | null;
  limits: { maxBuyers: number; buySolMax: number; buyEthMax: number };
}
export interface CoinSummary {
  id: string; name: string; symbol: string; image: string; launchedAt: number | null; pumpMint: string; ponsToken: string;
  pumpFdv: number | null; ponsFdv: number | null; gap: number | null; inBand: boolean | null; maker: string;
}
export interface PoolSummary {
  solana: { address: string; balance: number; floor: number };
  robinhood: { address: string; balance: number; floor: number };
  outstanding: { sol: number; eth: number };
  counts: { live: number; launching: number; queued: number; open: number };
}

export const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(0)}`);
export const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
export const img = (cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`;
