import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Robinhood Chain (id 4663). Addresses verified on-chain (spec §4.2 / §4.3).
export const ROBINHOOD_CHAIN = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.ordofi.network"] } },
} as const;

export const PONS = {
  factory: getAddress("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"),
  launchAndBuyRouter: getAddress("0xe33E9E479dF8802cb0866d5d05258bEc4cF62948"),
  memeHook: getAddress("0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044"),
  feeEscrow: getAddress("0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e"),
  poolManager: getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951"), // factory.poolManager() == hook.poolManager()
  universalRouter: getAddress("0x8876789976dEcBfCbBbe364623C63652db8C0904"),
  permit2: getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
  ZERO: "0x0000000000000000000000000000000000000000" as Address,
};

export const factoryAbi = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }",
  "struct LaunchConfig { uint256 supply; uint256 curveFeeBps; uint256 phantomQuote; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; bool enabled; }",
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function launchToken(TokenParams params, uint256 launchConfigId, address pairToken, address[] snipeTaxExemptions) payable returns (address token, address curve)",
  "function launchFee() view returns (uint256)",
  "function canLaunch(address launcher) view returns (bool)",
  "function launchEnabled() view returns (bool)",
  "function getLaunchConfig(uint256 id) view returns (LaunchConfig)",
  "function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
  "function createGraduatedPool(address token)",
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
]);

export const routerAbi = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }",
  "function launchAndBuy(TokenParams params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)",
]);

export const curveAbi = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)",
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function realQuoteReserve() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
  "function sellableTokens() view returns (uint256)",
  "function readyToGraduate() view returns (bool)",
  "function graduated() view returns (bool)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function currentSnipeTaxBps(address recipient) view returns (uint256)",
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

export const escrowAbi = parseAbi([
  "function balanceOf(address recipient) view returns (uint256)",
  "function claim()",
]);

export const TOKEN_SUPPLY = 1_000_000_000; // launch config 0: 1e27 wei-units = 1e9 tokens

export function publicClient(rpcUrl: string): PublicClient {
  return createPublicClient({ chain: ROBINHOOD_CHAIN, transport: http(rpcUrl, { timeout: 20_000 }) });
}

export function walletClient(rpcUrl: string, privateKey: string): WalletClient {
  const account = privateKeyToAccount(privateKey as Hex);
  return createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport: http(rpcUrl, { timeout: 20_000 }) });
}

export function addressOf(privateKey: string): Address {
  return privateKeyToAccount(privateKey as Hex).address;
}

export interface PonsCurveState {
  token: Address;
  curve: Address;
  creatorFeeRecipient: Address;
  creatorTaxBps: number;
  phase: number; // 0 curve, 1 swept (waiting for pool seed), 2 graduated (observed on TWINE)
  graduated: boolean;
  readyToGraduate: boolean;
  quoteReserve: bigint;
  tokenReserve: bigint;
  realQuoteReserve: bigint;
  graduationThreshold: bigint;
  sellableTokens: bigint;
  feeBps: bigint;
  price: number; // ETH per token (spot, incl. phantom quote)
  fdvEth: number;
  progress: number; // realQuote / threshold
  quoteDepthEth: number; // real ETH in the curve
}

export async function readLaunch(client: PublicClient, token: Address) {
  return client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] });
}

export async function readCurve(client: PublicClient, token: Address): Promise<PonsCurveState> {
  const l = await readLaunch(client, token);
  if (!l.exists) throw new Error(`Pons: ${token} is not a launched token`);
  const curve = l.curve;
  const c = (functionName: any, args: any[] = []) =>
    client.readContract({ address: curve, abi: curveAbi, functionName, args } as any) as Promise<any>;
  const [reserves, realQuote, threshold, sellable, feeBps, graduated, ready] = await Promise.all([
    c("getReserves"),
    c("realQuoteReserve"),
    c("graduationThreshold"),
    c("sellableTokens"),
    c("feeBps"),
    c("graduated"),
    c("readyToGraduate"),
  ]);
  const [quoteReserve, tokenReserve] = reserves as [bigint, bigint];
  const price = tokenReserve > 0n ? Number(quoteReserve) / Number(tokenReserve) : 0;
  return {
    token,
    curve,
    creatorFeeRecipient: l.creatorFeeRecipient,
    creatorTaxBps: Number(l.creatorTaxBps),
    phase: Number(l.phase),
    graduated: graduated as boolean,
    readyToGraduate: ready as boolean,
    quoteReserve,
    tokenReserve,
    realQuoteReserve: realQuote as bigint,
    graduationThreshold: threshold as bigint,
    sellableTokens: sellable as bigint,
    feeBps: feeBps as bigint,
    price,
    fdvEth: price * TOKEN_SUPPLY,
    progress: threshold > 0n ? Math.min(1, Number(realQuote) / Number(threshold)) : 0,
    quoteDepthEth: Number(realQuote) / 1e18,
  };
}

// ---- curve quoting, copied from the Pons docs (same integer order as the contract) ----
const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const amountOut = (inAmount: bigint, reserveIn: bigint, reserveOut: bigint) =>
  (inAmount * reserveOut) / (reserveIn + inAmount);
const amountIn = (outAmount: bigint, reserveIn: bigint, reserveOut: bigint) =>
  (outAmount * reserveIn) / (reserveOut - outAmount) + 1n;

export async function quoteBuy(client: PublicClient, curve: Address, quoteIn: bigint, recipient: Address) {
  const c = (functionName: any, args: any[] = []) =>
    client.readContract({ address: curve, abi: curveAbi, functionName, args } as any) as Promise<any>;
  const [reserves, sellable, feeBps, creatorTaxBps, rawSnipe] = await Promise.all([
    c("getReserves"),
    c("sellableTokens"),
    c("feeBps"),
    c("creatorTaxBps"),
    c("currentSnipeTaxBps", [recipient]),
  ]);
  const [quoteReserve, tokenReserve] = reserves as [bigint, bigint];
  let snipeBps = rawSnipe as bigint;
  if (snipeBps > 0n) {
    const max = BPS - feeBps - creatorTaxBps - 100n;
    if (snipeBps > max) snipeBps = max;
  }
  let spent = quoteIn;
  const fee = (spent * feeBps) / BPS;
  const tax = (spent * creatorTaxBps) / BPS;
  const snipeTax = (spent * snipeBps) / BPS;
  let tokensOut = amountOut(spent - fee - tax - snipeTax, quoteReserve, tokenReserve);
  if (tokensOut > sellable) {
    tokensOut = sellable;
    const net = amountIn(sellable, quoteReserve, tokenReserve);
    const grossed = ceilDiv(net * BPS, BPS - feeBps - creatorTaxBps - snipeBps);
    spent = grossed < quoteIn ? grossed : quoteIn;
  }
  return { tokensOut, spent, refund: quoteIn - spent, snipeBps };
}

export async function quoteSell(client: PublicClient, curve: Address, tokensIn: bigint) {
  const c = (functionName: any) =>
    client.readContract({ address: curve, abi: curveAbi, functionName } as any) as Promise<any>;
  const [reserves, feeBps, creatorTaxBps] = await Promise.all([c("getReserves"), c("feeBps"), c("creatorTaxBps")]);
  const [quoteReserve, tokenReserve] = reserves as [bigint, bigint];
  const gross = amountOut(tokensIn, tokenReserve, quoteReserve);
  return gross - (gross * feeBps) / BPS - (gross * creatorTaxBps) / BPS;
}

// ---- launch ----
export interface LaunchParams {
  name: string;
  symbol: string;
  logo: string; // ipfs://<cid> like TWINE
  description: string;
  twitter: string;
  telegram: string;
  website: string;
  creatorFeeRecipient: Address;
  creatorTaxBps: number;
  salt: Hex;
  exemptions: Address[];
}

export async function launchPreflight(client: PublicClient, launcher: Address) {
  const f = (functionName: any, args: any[] = []) =>
    client.readContract({ address: PONS.factory, abi: factoryAbi, functionName, args } as any) as Promise<any>;
  const [launchFee, canLaunch, enabled, cfg, economics] = await Promise.all([
    f("launchFee"),
    f("canLaunch", [launcher]),
    f("launchEnabled"),
    f("getLaunchConfig", [0n]),
    f("previewLaunchEconomics", [0n, PONS.ZERO]),
  ]);
  return {
    launchFee: launchFee as bigint,
    canLaunch: canLaunch as boolean,
    launchEnabled: enabled as boolean,
    config: cfg as { supply: bigint; curveFeeBps: bigint; phantomQuote: bigint; graduationThreshold: bigint; poolFee: number; tickSpacing: number; enabled: boolean },
    expectedEconomics: economics as Hex,
  };
}

export function buildLaunchCalldata(p: LaunchParams, expectedEconomics: Hex): Hex {
  if (p.exemptions.length > 32) throw new Error("max 32 snipe-tax exemptions");
  if (p.creatorTaxBps > 1000) throw new Error("maxCreatorTaxBps is 1000");
  return encodeFunctionData({
    abi: factoryAbi,
    functionName: "launchToken",
    args: [
      {
        name: p.name,
        symbol: p.symbol,
        logo: p.logo,
        description: p.description,
        socials: { twitter: p.twitter, telegram: p.telegram, discord: "", website: p.website, farcaster: "" },
        creatorFeeRecipient: p.creatorFeeRecipient,
        creatorTaxBps: p.creatorTaxBps,
        buybackEnabled: false,
        expectedEconomics,
        salt: p.salt,
      },
      0n,
      PONS.ZERO,
      p.exemptions,
    ],
  });
}

/** Pull `token` and `curve` from a launch receipt's TokenLaunched event. */
export function parseTokenLaunched(logs: { address: Address; data: Hex; topics: Hex[] }[]) {
  for (const log of logs) {
    if (log.address.toLowerCase() !== PONS.factory.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: factoryAbi, data: log.data, topics: log.topics as any });
      if (ev.eventName === "TokenLaunched") {
        const a = ev.args as { token: Address; curve: Address };
        return { token: a.token, curve: a.curve };
      }
    } catch {
      /* not ours */
    }
  }
  return null;
}
