import { useEffect, useState } from "react";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getJson } from "./api";

export type PayChain = "sol" | "eth";

/** Robinhood Chain (4663) as wallets want it for wallet_addEthereumChain. */
export const ROBINHOOD = {
  chainId: "0x1237",
  chainName: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
  blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
};

/** One wallet the browser exposes. `pay` sends the deposit from `expectedFrom` and returns the signature / tx hash. */
export interface DetectedWallet {
  key: string;
  name: string;
  icon?: string;
  chain: PayChain;
  connect(): Promise<string>;
  pay(expectedFrom: string, to: string, amount: number): Promise<string>;
}

// ---- EVM wallets: EIP-6963 announces every injected provider with a name and icon; window.ethereum is the fallback.
interface Eip1193 { request(args: { method: string; params?: unknown[] }): Promise<unknown> }
interface Eip6963Detail { info: { uuid: string; name: string; icon: string; rdns: string }; provider: Eip1193 }

// ---- Solana wallets: the Wallet Standard. Wallets register themselves with name, icon, chains and features.
interface StdAccount { address: string; publicKey: Uint8Array; chains: readonly string[] }
interface StdWallet { name: string; icon: string; chains: readonly string[]; accounts: readonly StdAccount[]; features: Record<string, unknown> }
interface StdConnect { connect(): Promise<{ accounts: readonly StdAccount[] }> }
interface StdSignAndSend {
  signAndSendTransaction(...inputs: { transaction: Uint8Array; account: StdAccount; chain: string }[]): Promise<{ signature: Uint8Array }[]>;
}
interface LegacyPhantom { isPhantom?: boolean; connect(): Promise<{ publicKey: PublicKey }>; signAndSendTransaction(tx: Transaction): Promise<{ signature: string }> }

declare global {
  interface Window { solana?: LegacyPhantom; ethereum?: Eip1193 }
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}

/** Decimal ETH → wei as 0x hex, without float rounding. */
export function toWeiHex(eth: number | string): string {
  const [i, f = ""] = String(eth).split(".");
  const wei = BigInt(i || "0") * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18));
  return `0x${wei.toString(16)}`;
}

/** Switch an EVM wallet to Robinhood Chain, adding it first when the wallet does not know it. */
async function ensureRobinhoodChain(p: Eip1193) {
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ROBINHOOD.chainId }] });
  } catch (e) {
    const err = e as { code?: number; message?: string };
    if (err.code === 4902 || /4902|unrecognized|not (been )?added/i.test(err.message ?? "")) {
      await p.request({ method: "wallet_addEthereumChain", params: [ROBINHOOD] });
    } else {
      throw e;
    }
  }
}

function evmWallet(name: string, icon: string | undefined, rdns: string, p: Eip1193): DetectedWallet {
  const connect = async () => {
    const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
    if (!accounts?.[0]) throw new Error(`${name} returned no account.`);
    return accounts[0];
  };
  return {
    key: `eth:${rdns}`, name, icon, chain: "eth", connect,
    async pay(expectedFrom, to, eth) {
      const from = await connect();
      if (from.toLowerCase() !== expectedFrom.toLowerCase()) throw new Error(`Switch ${name} to the wallet you entered (${short(expectedFrom)}).`);
      await ensureRobinhoodChain(p);
      return (await p.request({ method: "eth_sendTransaction", params: [{ from, to, value: toWeiHex(eth) }] })) as string;
    },
  };
}

function solWallet(w: StdWallet): DetectedWallet {
  const connect = async () => {
    const { accounts } = await (w.features["standard:connect"] as StdConnect).connect();
    const a = accounts[0] ?? w.accounts[0];
    if (!a) throw new Error(`${w.name} returned no account.`);
    return a.address;
  };
  return {
    key: `sol:${w.name}`, name: w.name, icon: w.icon, chain: "sol", connect,
    async pay(expectedFrom, to, sol) {
      const { accounts } = await (w.features["standard:connect"] as StdConnect).connect();
      const account = [...accounts, ...w.accounts].find((a) => a.address === expectedFrom);
      if (!account) throw new Error(`Switch ${w.name} to the wallet you entered (${short(expectedFrom)}).`);
      const { blockhash } = await getJson<{ blockhash: string }>("/api/chain/blockhash");
      const from = new PublicKey(expectedFrom);
      const tx = new Transaction({ feePayer: from, recentBlockhash: blockhash }).add(
        SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(to), lamports: Math.round(sol * LAMPORTS_PER_SOL) }),
      );
      const [r] = await (w.features["solana:signAndSendTransaction"] as StdSignAndSend).signAndSendTransaction({
        transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }), account, chain: "solana:mainnet",
      });
      return base58(r.signature);
    },
  };
}

function legacyPhantom(p: LegacyPhantom): DetectedWallet {
  return {
    key: "sol:Phantom", name: "Phantom", chain: "sol",
    connect: async () => (await p.connect()).publicKey.toBase58(),
    async pay(expectedFrom, to, sol) {
      const { publicKey } = await p.connect();
      if (publicKey.toBase58() !== expectedFrom) throw new Error(`Switch Phantom to the wallet you entered (${short(expectedFrom)}).`);
      const { blockhash } = await getJson<{ blockhash: string }>("/api/chain/blockhash");
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash }).add(
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: new PublicKey(to), lamports: Math.round(sol * LAMPORTS_PER_SOL) }),
      );
      return (await p.signAndSendTransaction(tx)).signature;
    },
  };
}

/**
 * Every wallet the browser exposes, live: EVM wallets via EIP-6963 (Phantom, MetaMask, Rabby, Coinbase, …),
 * Solana wallets via the Wallet Standard (Phantom, Solflare, Backpack, …). Falls back to window.ethereum /
 * window.solana for wallets that predate both. Solana wallets first, then EVM.
 */
export function useWallets(): DetectedWallet[] {
  const [list, setList] = useState<DetectedWallet[]>([]);
  useEffect(() => {
    const found = new Map<string, DetectedWallet>();
    const publish = () => setList([...found.values()].sort((a, b) => (a.chain === b.chain ? a.name.localeCompare(b.name) : a.chain === "sol" ? -1 : 1)));
    const add = (w: DetectedWallet) => { if (!found.has(w.key)) { found.set(w.key, w); publish(); } };

    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent<Eip6963Detail>).detail;
      if (d?.provider && d.info) add(evmWallet(d.info.name, d.info.icon, d.info.rdns || d.info.uuid, d.provider));
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    const register = (...ws: StdWallet[]) => {
      for (const w of ws) {
        if (w.chains?.some((c) => c.startsWith("solana:")) && w.features?.["standard:connect"] && w.features["solana:signAndSendTransaction"]) add(solWallet(w));
      }
    };
    const onRegister = (e: Event) => {
      const cb = (e as CustomEvent<(api: { register: typeof register }) => void>).detail;
      if (typeof cb === "function") cb({ register });
    };
    window.addEventListener("wallet-standard:register-wallet", onRegister);
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: { register } }));

    const t = setTimeout(() => {
      const has = (c: PayChain) => [...found.values()].some((w) => w.chain === c);
      if (!has("eth") && window.ethereum) add(evmWallet("Browser wallet", undefined, "injected", window.ethereum));
      if (!has("sol") && window.solana?.isPhantom) add(legacyPhantom(window.solana));
    }, 400);
    return () => {
      clearTimeout(t);
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      window.removeEventListener("wallet-standard:register-wallet", onRegister);
    };
  }, []);
  return list;
}
