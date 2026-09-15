import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

// Load order: every path in ENV_FILE (colon-separated), then ./.env. Earlier files and
// values already in the environment win, so e.g. ENV_FILE=../../PAID/.env supplies the
// Solana RPC_URL + LAUNCHER_KEY while ./.env carries the EVM key, token fields and Pinata.
const envFiles = [...(process.env.ENV_FILE ? process.env.ENV_FILE.split(":") : []), path.resolve(process.cwd(), ".env")];
for (const f of envFiles) if (f && fs.existsSync(f)) dotenv.config({ path: f });

const env = (k: string, fallback?: string): string => {
  const v = process.env[k]?.trim();
  // "<fill>" is the placeholder used in .env.example / .env and counts as unset.
  if (v !== undefined && v !== "" && v !== "<fill>") return v;
  if (fallback !== undefined) return fallback;
  return "";
};
const num = (k: string, fallback: number): number => {
  const v = env(k);
  if (v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${k} is not a number: ${v}`);
  return n;
};
const bool = (k: string, fallback: boolean): boolean => {
  const v = env(k).toLowerCase();
  if (v === "") return fallback;
  return v === "1" || v === "true" || v === "yes";
};

export const config = {
  solana: {
    rpcUrl: env("SOLANA_RPC_URL", env("RPC_URL", "https://api.mainnet-beta.solana.com")),
    slippagePct: num("SOL_SLIPPAGE_PCT", 10),
    priorityFeeSol: num("SOL_PRIORITY_FEE_SOL", 0.0005),
  },
  evm: {
    rpcUrl: env("EVM_RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
    creatorTaxBps: num("EVM_CREATOR_TAX_BPS", 200),
  },
  pool: {
    solKey: env("POOL_SOL_KEY"),
    evmKey: env("POOL_EVM_KEY"),
    minSol: num("POOL_MIN_SOL", 5),
    minEth: num("POOL_MIN_ETH", 0.05),
  },
  launch: {
    depositSol: num("DEPOSIT_SOL", 0.5),
    depositDeadlineMin: num("DEPOSIT_DEADLINE_MIN", 60),
    /** Ceilings for what the pool fronts one launch. With AUTO_SIZE the actual front is what the pool can spare per open slot, between the min and these. */
    frontSol: num("FRONT_SOL", 13.8),
    frontEth: num("FRONT_ETH", 0.33),
    frontSolMin: num("FRONT_SOL_MIN", 0.6),
    frontEthMin: num("FRONT_ETH_MIN", 0.03),
    autoSize: bool("AUTO_SIZE", true),
    /** Deployers may add up to this much SOL to the dev buy on top of the deposit. 0 disables boosts. */
    maxBoostSol: num("MAX_BOOST_SOL", 20),
    solGasBudget: num("SOL_GAS_BUDGET", 0.13),
    /** Out of the gas budget: what the pump.fun creator wallet gets (create rent + bundle tip). The rest stays with the maker as gas. */
    solCreatorSol: num("SOL_CREATOR_SOL", 0.04),
    /** Jito tip for the create + opening-buy bundle (the creator never holds tokens, so pump.fun shows no dev buys or sells). */
    jitoTipSol: num("JITO_TIP_SOL", 0.001),
    jitoBlockEngine: env("JITO_BLOCK_ENGINE") || "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
    evmGasLauncher: num("EVM_GAS_LAUNCHER", 0.012),
    evmMakerCash: num("EVM_MAKER_CASH", 0.01),
    /** Open a Pons position with the whole ETH front (minus maker cash) even when parity sizing calls for less: a maker with
     *  nothing to sell on Robinhood can only buy the cheap side with pool money whenever Robinhood runs ahead (the $TWINE bleed). */
    seedPons: bool("SEED_PONS", true),
    autoApprove: bool("AUTO_APPROVE", false),
    /** The operator's off switch: true refuses every new launch (public form and admin bundle) and holds the queue —
     *  nothing is approved, retried or launched until it is false again. Unlike the loss breaker it survives restarts. */
    launchesClosed: bool("LAUNCHES_CLOSED", false),
    adminToken: env("ADMIN_TOKEN"),
    /** Comma-separated. Wallets that may not launch; name/symbol substrings that are reserved. Admin bans persist in DATA_DIR/bans.json. */
    bannedWallets: env("BANNED_WALLETS"),
    bannedNames: env("BANNED_NAMES"),
    maxLiveMakers: num("MAX_LIVE_MAKERS", 10),
    maxOpenLaunches: num("MAX_OPEN_LAUNCHES", 20),
    /** Failed launches are re-queued this many times before an operator has to retry by hand. */
    autoRetries: num("LAUNCH_AUTO_RETRIES", 2),
    retryBackoffMin: num("LAUNCH_RETRY_BACKOFF_MIN", 5),
  },
  /** Exit policy: at launch + afterMin the coin needs minBuyers outside holders or minUsd of outside-held value, else the pool exits. */
  retire: {
    enabled: bool("RETIRE_ENABLED", true),
    afterMin: num("RETIRE_AFTER_MIN", 10),
    minBuyers: num("RETIRE_MIN_BUYERS", 5),
    minUsd: num("RETIRE_MIN_USD", 100),
    selldownMin: num("RETIRE_SELLDOWN_MIN", 45),
  },
  /** Front recovery: sell clips above entry until the front is repaid, sweep surplus quote to the pool, top the maker's ETH up when Pons demand drains it. */
  recover: {
    enabled: bool("RECOVER_ENABLED", true),
    /** Harvest sells only at entry × (1 + margin). */
    margin: num("RECOVER_MARGIN", 0.1),
    /** Quote kept in each maker wallet: MAKER_MIN_* plus this many clips. Anything above goes back to the pool. */
    keepClips: num("RECOVER_KEEP_CLIPS", 4),
    topupEth: num("TOPUP_ETH", 0.02),
    maxTopupEthPerCoin: num("MAX_TOPUP_ETH_PER_COIN", 0.2),
    topupSol: num("TOPUP_SOL", 0.5),
    /** Creator fees are claimed while live once at least this much is waiting (pump.fun creator vault / Pons escrow). */
    claimMinSol: num("CLAIM_MIN_SOL", 0.01),
    claimMinEth: num("CLAIM_MIN_ETH", 0.002),
    maxTopupSolPerCoin: num("MAX_TOPUP_SOL_PER_COIN", 3),
  },
  /** Loss budgets in USD (fronted value − current inventory value). Coin: halt that maker. Pool: halt every maker and stop approving. */
  guard: {
    maxLossUsdPerCoin: num("MAX_LOSS_USD_PER_COIN", 150),
    maxLossUsdPool: num("MAX_LOSS_USD_POOL", 500),
    alertWebhookUrl: env("ALERT_WEBHOOK_URL"),
  },
  pinataJwt: env("PINATA_JWT"),
  maker: {
    band: num("BAND", 0.05),
    enabled: bool("MAKER_ENABLED", true),
    intervalMs: num("MAKER_INTERVAL_MS", 1000),
    /** Price poll for every live coin (both curves + fx). */
    pollMs: num("POLL_INTERVAL_MS", 1000),
    maxClipUsd: num("MAKER_MAX_CLIP_USD", 300),
    minSol: num("MAKER_MIN_SOL", 0.3),
    minEth: num("MAKER_MIN_ETH", 0.01),
    maxErrors: num("MAKER_MAX_ERRORS", 5),
    /** Per side, the peg may hold at most this many clips (at cost) of tokens it bought on top of the opening position;
     *  sells release it. Past the ceiling the cheap-side buy is skipped and the pool does not top the side up. */
    maxBoughtClips: num("MAKER_MAX_BOUGHT_CLIPS", 12),
  },
  server: {
    port: num("PORT", 8787),
    corsOrigin: env("CORS_ORIGIN", "*"),
    /** Public URL of the web app. Every token's website link points at its coin page here. */
    publicUrl: env("PUBLIC_URL", "").replace(/\/+$/, ""),
    dataDir: path.resolve(process.cwd(), env("DATA_DIR", "./data")),
  },
};

export type Config = typeof config;

/** Never print secrets. Use this when echoing config. */
export function redactedConfig() {
  const c = JSON.parse(JSON.stringify(config)) as Config;
  const mask = (s: string) => (s ? `set (${s.length} chars)` : "missing");
  c.pool.solKey = mask(c.pool.solKey);
  c.pool.evmKey = mask(c.pool.evmKey);
  c.launch.adminToken = mask(c.launch.adminToken);
  c.pinataJwt = mask(c.pinataJwt);
  c.guard.alertWebhookUrl = c.guard.alertWebhookUrl ? "set" : "missing";
  // RPC URLs can embed API keys: show host only.
  c.solana.rpcUrl = safeHost(c.solana.rpcUrl);
  c.evm.rpcUrl = safeHost(c.evm.rpcUrl);
  return c;
}

/** Host(s) only: RPC URLs can embed API keys. Accepts the comma-separated list EVM_RPC_URL allows. */
export function safeHost(url: string): string {
  return url
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean)
    .map((u) => {
      try {
        return new URL(u).host;
      } catch {
        return "(invalid url)";
      }
    })
    .join(",") || "(invalid url)";
}
