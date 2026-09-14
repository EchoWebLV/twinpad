import { Connection, PublicKey } from "@solana/web3.js";
import { pda, TOTAL_SUPPLY_TOKENS } from "./pump.js";

export interface PumpSwapPoolState {
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  baseTokens: number; // whole tokens
  quoteSol: number; // whole SOL
  price: number; // SOL per token
  fdvSol: number;
}

/**
 * Parse the PumpSwap `Pool` account (discriminator f19a6d0411b16dbc):
 * u8 bump, u16 index, then creator, base_mint, quote_mint, lp_mint,
 * pool_base_token_account, pool_quote_token_account (32 bytes each).
 */
function parsePool(pool: PublicKey, data: Buffer) {
  let o = 8 + 1 + 2;
  const pk = () => {
    const k = new PublicKey(data.subarray(o, o + 32));
    o += 32;
    return k;
  };
  pk(); // creator
  const baseMint = pk();
  const quoteMint = pk();
  pk(); // lp mint
  const baseVault = pk();
  const quoteVault = pk();
  return { pool, baseMint, quoteMint, baseVault, quoteVault };
}

export async function readPumpSwapPool(conn: Connection, mint: PublicKey): Promise<PumpSwapPoolState | null> {
  const pool = pda.pumpSwapPool(mint);
  const info = await conn.getAccountInfo(pool, "processed");
  if (!info) return null;
  const p = parsePool(pool, info.data);
  const [b, q] = await Promise.all([
    conn.getTokenAccountBalance(p.baseVault, "processed"),
    conn.getTokenAccountBalance(p.quoteVault, "processed"),
  ]);
  const baseTokens = Number(b.value.uiAmountString ?? b.value.uiAmount ?? 0);
  const quoteSol = Number(q.value.uiAmountString ?? q.value.uiAmount ?? 0);
  const price = baseTokens > 0 ? quoteSol / baseTokens : 0;
  return { ...p, baseTokens, quoteSol, price, fdvSol: price * TOTAL_SUPPLY_TOKENS };
}
