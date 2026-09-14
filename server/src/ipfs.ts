import fs from "node:fs";
import path from "node:path";

/**
 * Pinata v3 uploads (what PumpPortal's own create examples use, since pump.fun/api/ipfs was retired).
 * Returns the CID. Requires PINATA_JWT.
 */
export async function pinFile(jwt: string, filePath: string, fileName?: string): Promise<string> {
  const form = new FormData();
  form.append("network", "public");
  const blob = new Blob([fs.readFileSync(filePath)]);
  form.append("file", blob, fileName ?? path.basename(filePath));
  return pinForm(jwt, form);
}

export async function pinJson(jwt: string, obj: unknown, fileName = "metadata.json"): Promise<string> {
  const form = new FormData();
  form.append("network", "public");
  form.append("file", new File([JSON.stringify(obj)], fileName, { type: "application/json" }));
  return pinForm(jwt, form);
}

async function pinForm(jwt: string, form: FormData): Promise<string> {
  const r = await fetch("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`pinata ${r.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text) as { data?: { cid?: string } };
  if (!j.data?.cid) throw new Error(`pinata: no cid in response: ${text.slice(0, 300)}`);
  return j.data.cid;
}

export const GATEWAYS = ["https://ipfs.io/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://cloudflare-ipfs.com/ipfs/"];

/** Verify a CID resolves over HTTP on at least one public gateway. Returns the working URL. */
export async function verifyCid(cid: string, expectJson = false): Promise<string> {
  const errors: string[] = [];
  for (const g of GATEWAYS) {
    const url = g + cid;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (r.ok) {
          if (expectJson) JSON.parse(await r.text());
          return url;
        }
        errors.push(`${url} -> ${r.status}`);
      } catch (e) {
        errors.push(`${url} -> ${(e as Error).message}`);
      }
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
  throw new Error(`CID ${cid} did not resolve: ${errors.slice(-3).join("; ")}`);
}
