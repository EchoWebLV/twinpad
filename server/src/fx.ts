/** SOL and ETH in USD from Coinbase's public spot endpoint (no key). Cached for 15 s. */
let cache: { at: number; SOL: number; ETH: number } | null = null;

async function spot(pair: string): Promise<number> {
  const r = await fetch(`https://api.coinbase.com/v2/prices/${pair}/spot`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`coinbase ${pair} ${r.status}`);
  const j = (await r.json()) as { data: { amount: string } };
  const n = Number(j.data.amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`coinbase ${pair} bad amount`);
  return n;
}

export async function fx(): Promise<{ SOL: number; ETH: number }> {
  if (cache && Date.now() - cache.at < 15_000) return { SOL: cache.SOL, ETH: cache.ETH };
  const [SOL, ETH] = await Promise.all([spot("SOL-USD"), spot("ETH-USD")]);
  cache = { at: Date.now(), SOL, ETH };
  return { SOL, ETH };
}
