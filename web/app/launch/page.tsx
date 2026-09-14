"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getJson, postJson, usd, type Launch, type Quote } from "../../lib/api";

export default function LaunchForm() {
  const router = useRouter();
  const [q, setQ] = useState<Quote | null>(null);
  const [f, setF] = useState({ name: "", symbol: "", description: "", twitter: "", website: "", telegram: "", devWallet: "" });
  const [image, setImage] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    getJson<Quote>("/api/paid/quote").then(setQ).catch((e) => setErr((e as Error).message));
  }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setErr("image max 2 MB"); return; }
    const r = new FileReader();
    r.onload = () => setImage(String(r.result));
    r.readAsDataURL(file);
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const rec = await postJson<Launch>("/api/paid", { ...f, imageDataUrl: image });
      router.push(`/launch/${rec.id}`);
    } catch (er) {
      setErr((er as Error).message);
      setBusy(false);
    }
  };
  return (
    <main>
      <header>
        <a href="/" className="back">← all coins</a>
        <div>
          <h1>Launch a coin</h1>
          <div className="sub">Pay the deposit, the pool fronts the maker on both chains, your coin goes live on pump.fun and Pons in the same minute.</div>
        </div>
      </header>
      {q && (
        <div className="card quote">
          <div className="row"><span>deposit</span><b>{q.depositSol} SOL</b></div>
          <div className="row"><span>pool fronts</span><b>{q.frontSol} SOL + {q.frontEth} ETH</b></div>
          <div className="row"><span>opening fdv</span><b>{usd(q.openingFdv)} (pump {usd(q.landing.pump)} / pons {usd(q.landing.pons)})</b></div>
          <div className="row"><span>maker inventory</span><b>{q.supplyPct.pump}% on pump.fun · {q.supplyPct.pons}% on Pons</b></div>
        </div>
      )}
      <form className="card form" onSubmit={submit}>
        <label>Name<input required maxLength={32} value={f.name} onChange={set("name")} /></label>
        <label>Symbol<input required maxLength={10} value={f.symbol} onChange={set("symbol")} /></label>
        <label>Description<textarea required maxLength={500} value={f.description} onChange={set("description")} /></label>
        <label>Image (PNG/JPEG, ≤ 2 MB)<input required type="file" accept="image/png,image/jpeg" onChange={onFile} /></label>
        {image && <img className="preview" src={image} alt="" />}
        <label>Twitter<input value={f.twitter} onChange={set("twitter")} /></label>
        <label>Website<input value={f.website} onChange={set("website")} /></label>
        <label>Telegram<input value={f.telegram} onChange={set("telegram")} /></label>
        <label>Your Solana wallet (pays the deposit, receives refunds)<input required value={f.devWallet} onChange={set("devWallet")} /></label>
        {err && <p className="err">{err}</p>}
        <button className="btn" disabled={busy || !image}>{busy ? "creating…" : "Create launch"}</button>
      </form>
    </main>
  );
}
