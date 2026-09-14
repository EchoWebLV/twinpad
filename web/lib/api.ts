export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { cache: "no-store" });
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
  wallets: { pumpMint: string; solCreator: string; evmLauncher: string; evmMaker: string; payment: string; evmPayment: string };
  payment: {
    chain: "sol" | "eth"; unit: "SOL" | "ETH"; address: string; required: number; received: number; paidAt: number | null; deadlineAt: number;
    txs: { tx: string; amount: number; late: boolean }[]; foreign: { tx: string; amount: number }[]; claimed: string[];
  };
  approval: { status: string; at: number | null; note: string | null; auto: boolean };
  front: { sol: number; eth: number; at: number | null; repaidSol: number; repaidEth: number; topupEth: number; retiredAt: number | null };
  launch: { steps: Step[]; pumpMint: string | null; ponsToken: string | null; error: string | null; retries: number };
  refund: { amount: number; paid: number; txs: string[] };
  retire: {
    decideAt: number; policy: { afterMin: number; minBuyers: number; minUsd: number; selldownMin: number }; keep: boolean;
    evaluated: { at: number; outsideBuyers: number; outsideUsd: number; verdict: "keep" | "full" | "selldown" } | null;
    selldownUntil: number | null; mode: "full" | "selldown" | null; reason: string | null; closedAt: number | null;
    sold: { pumpTokens: number; ponsTokens: number; txs: string[] }; swept: { sol: number; eth: number; txs: string[] }; error: string | null;
  } | null;
  quote: Quote;
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
