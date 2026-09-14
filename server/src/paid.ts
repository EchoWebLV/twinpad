import fs from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress, isAddress } from "viem";
import type { Registry } from "./registry.js";
import { newRecord, type LaunchRecord, type PaymentChain, type Quote } from "./record.js";

export interface CreateInput {
  name: string; symbol: string; description: string; twitter?: string; telegram?: string;
  devWallet: string; imageDataUrl: string;
  /** Extra SOL the deployer adds to the dev buy (paid with the deposit; SOL deposits only). */
  boostSol: number;
  /** "sol" (default): deposit in SOL from a Solana wallet. "eth": deposit in ETH on Robinhood Chain from an EVM wallet. */
  payChain: PaymentChain;
}

export interface CreateDeps {
  registry: Registry;
  pin: { file: (path: string, name: string) => Promise<string>; json: (obj: unknown, name: string) => Promise<string> };
  quote: (boostSol: number) => Promise<Quote>;
  /** Upper bound for `boostSol`; 0 disables boosts. */
  maxBoostSol: number;
  deadlineMin: number;
  now: () => number;
  /** Public web URL; the token website is always `<publicUrl>/coin/<id>` (empty → no website). */
  publicUrl: string;
}

const MAX_IMAGE = 2 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPG = Buffer.from([0xff, 0xd8, 0xff]);

export function validateInput(raw: unknown, maxBoostSol = 0): CreateInput & { image: Buffer } {
  const i = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string, max: number, required = false) => {
    const v = typeof i[k] === "string" ? (i[k] as string).trim() : "";
    if (required && !v) throw new Error(`${k} is required`);
    if (v.length > max) throw new Error(`${k} max ${max} chars`);
    return v;
  };
  const name = str("name", 32, true);
  const symbol = str("symbol", 10, true).toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol)) throw new Error("symbol must be letters and digits");
  const description = str("description", 500, true);
  const payChain: PaymentChain = i.payChain === "eth" ? "eth" : i.payChain === "sol" || i.payChain == null ? "sol" : (() => { throw new Error("payChain must be sol or eth"); })();
  let devWallet = str("devWallet", 64, true);
  if (payChain === "eth") {
    if (!isAddress(devWallet)) throw new Error("devWallet is not an EVM address");
    devWallet = getAddress(devWallet);
  } else {
    try {
      new PublicKey(devWallet);
    } catch {
      throw new Error("devWallet is not a Solana address");
    }
  }
  const boostRaw = i.boostSol == null || i.boostSol === "" ? 0 : Number(i.boostSol);
  if (!Number.isFinite(boostRaw) || boostRaw < 0) throw new Error("boostSol must be a non-negative number");
  const boostSol = Math.round(boostRaw * 1e6) / 1e6;
  if (boostSol > maxBoostSol) throw new Error(maxBoostSol > 0 ? `boostSol max ${maxBoostSol} SOL` : "boosts are off");
  if (boostSol > 0 && payChain !== "sol") throw new Error("boostSol needs a SOL deposit");
  const url = typeof i.imageDataUrl === "string" ? i.imageDataUrl : "";
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!m) throw new Error("image must be a PNG or JPEG data URL");
  const image = Buffer.from(m[2], "base64");
  if (image.length > MAX_IMAGE) throw new Error("image max 2 MB");
  if (!(image.subarray(0, 4).equals(PNG) || image.subarray(0, 3).equals(JPG))) throw new Error("image bytes are not PNG/JPEG");
  return {
    name, symbol, description, devWallet, payChain, boostSol, imageDataUrl: url, image,
    twitter: str("twitter", 120), telegram: str("telegram", 120),
  };
}

/** Validate, store the image, pin image + metadata, generate keys, write the record. No chain calls. */
export async function createLaunch(d: CreateDeps, raw: unknown): Promise<LaunchRecord> {
  const input = validateInput(raw, d.maxBoostSol);
  const id = d.registry.newId(input.symbol);
  const website = d.publicUrl ? `${d.publicUrl}/coin/${id}` : "";
  fs.mkdirSync(d.registry.dir(id), { recursive: true });
  fs.writeFileSync(d.registry.imagePath(id), input.image);

  const imageCid = await d.pin.file(d.registry.imagePath(id), `${input.symbol}.png`);
  const meta = {
    name: input.name, symbol: input.symbol, description: input.description,
    image: `https://ipfs.io/ipfs/${imageCid}`, showName: true, createdOn: "https://pump.fun",
    twitter: input.twitter || undefined, telegram: input.telegram || undefined, website: website || undefined,
  };
  const metadataCid = await d.pin.json(meta, `${input.symbol}-metadata.json`);

  const mint = Keypair.generate();
  const solCreator = Keypair.generate();
  const solMaker = Keypair.generate();
  const payment = Keypair.generate();
  const evmLauncherKey = generatePrivateKey();
  const evmMakerKey = generatePrivateKey();
  const evmPaymentKey = generatePrivateKey();
  d.registry.saveKeys(id, {
    mint: Array.from(mint.secretKey), solCreator: Array.from(solCreator.secretKey), solMaker: Array.from(solMaker.secretKey), payment: Array.from(payment.secretKey),
    evmLauncher: evmLauncherKey, evmMaker: evmMakerKey, evmPayment: evmPaymentKey,
  });

  const now = d.now();
  const rec = newRecord({
    id,
    now,
    deadlineAt: now + d.deadlineMin * 60_000,
    devWallet: input.devWallet,
    chain: input.payChain,
    quote: await d.quote(input.boostSol),
    token: {
      name: input.name, symbol: input.symbol, description: input.description,
      twitter: input.twitter ?? "", website, telegram: input.telegram ?? "",
      imageCid, metadataCid, metadataUri: `https://ipfs.io/ipfs/${metadataCid}`,
    },
    wallets: {
      pumpMint: mint.publicKey.toBase58(),
      solCreator: solCreator.publicKey.toBase58(),
      solMaker: solMaker.publicKey.toBase58(),
      evmLauncher: privateKeyToAccount(evmLauncherKey).address,
      evmMaker: privateKeyToAccount(evmMakerKey).address,
      payment: payment.publicKey.toBase58(),
      evmPayment: privateKeyToAccount(evmPaymentKey).address,
    },
  });
  d.registry.save(rec);
  return rec;
}
