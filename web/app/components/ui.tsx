"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { getJson } from "../../lib/api";

/** Twinpad mark: the cat, half yellow half black — one coin, two chains. */
export function Mark({ size = 30 }: { size?: number }) {
  return <img className="mark" src="/logo.png" width={size} height={size} alt="" />;
}

export function Nav() {
  const path = usePathname();
  const [up, setUp] = useState<boolean | null>(null);
  useEffect(() => {
    const tick = () => getJson<{ ok: boolean }>("/api/health").then((h) => setUp(h.ok)).catch(() => setUp(false));
    tick();
    const t = setInterval(tick, 15_000);
    return () => clearInterval(t);
  }, []);
  const on = (p: string) => (p === "/" ? path === "/" : path.startsWith(p)) ? "on" : "";
  return (
    <>
      <div className="rail">Twinpad <b>—</b> pump.fun × Pons v2 <b>—</b> Solana / Robinhood Chain 4663</div>
      <nav className="nav">
        <a className="brand" href="/"><Mark />Twinpad</a>
        <div className="links">
          <a className={on("/")} href="/">Coins</a>
          <a className={on("/launch")} href="/launch">Launch</a>
        </div>
        <div className="right">
          <span className={`st ${up == null ? "off" : up ? "ok" : "bad"}`} title="API status">{up == null ? "connecting" : up ? "online" : "offline"}</span>
          {path !== "/launch" && <a className="btn y sm" href="/launch">Launch <span className="ar">→</span></a>}
        </div>
      </nav>
    </>
  );
}

export function Ticker({ items }: { items: React.ReactNode[] }) {
  if (items.length === 0) return null;
  const row = items.map((it, i) => <span key={i}>{it}</span>);
  return (
    <div className="ticker">
      <div className="track">{row}{items.map((it, i) => <span key={`b${i}`}>{it}</span>)}</div>
    </div>
  );
}

export const STATUS_LABEL: Record<string, string> = {
  awaiting_deposit: "awaiting deposit",
  paid: "paid",
  approved: "queued",
  launching: "launching",
  live: "live",
  rejected: "rejected",
  expired: "expired",
  failed: "failed",
};

export function Status({ status }: { status: string }) {
  return <span className={`st ${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function Img({ src, size, alt = "" }: { src?: string | null; size: number; alt?: string }) {
  const [bad, setBad] = useState(false);
  if (!src || bad) return <div className="ph" style={{ width: size, height: size }} />;
  return <img src={src} alt={alt} width={size} height={size} onError={() => setBad(true)} />;
}

export function short(a: string, n = 4) {
  return a.length <= n * 2 + 1 ? a : `${a.slice(0, n)}…${a.slice(-n)}`;
}

export function ago(t: number) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function Copy({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button className="btn sm" onClick={() => { navigator.clipboard.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); }); }}>
      {ok ? "copied" : "copy"}
    </button>
  );
}

/** Animated band between the two venues: marker = where the gap sits inside ±band, flow runs from the expensive side to the cheap side. */
export function Band({ gap, pumpFdv, ponsFdv, band = 0.05, big = false, labels = true }: { gap: number | null; pumpFdv: number | null; ponsFdv: number | null; band?: number; big?: boolean; labels?: boolean }) {
  const have = gap != null && pumpFdv != null && ponsFdv != null;
  const sign = have && pumpFdv! > ponsFdv! ? -1 : 1;
  const pos = have ? 50 + Math.max(-48, Math.min(48, sign * (gap! / band) * 10)) : 50;
  const out = have && gap! > band;
  const dir = !have || gap! < 0.0005 ? "flat" : sign < 0 ? "" : "l";
  return (
    <div className={`band ${big ? "big" : ""} ${dir} ${out ? "out" : ""}`} style={{ "--pos": `${pos}%` } as React.CSSProperties} title="where the price gap sits inside the band">
      <span className="line" /><span className="flow" /><span className="zone" /><span className="mid" />
      <span className="end" /><span className="end r" /><span className="mk" />
      {labels && <><span className="lbl">pump.fun</span><span className="lbl c">±{Math.round(band * 100)}%</span><span className="lbl r">Pons</span></>}
    </div>
  );
}

export function Sh({ n, title, sub }: { n: string; title: string; sub?: string }) {
  return <div className="sh"><span className="n">{n}</span><h2>{title}</h2>{sub && <span className="sub">{sub}</span>}</div>;
}

export const PUMP = (mint: string) => `https://pump.fun/coin/${mint}`;
export const PONS = (token: string) => `https://ponsfamily.com/token/${token}`;
export const SOLSCAN = (tx: string) => `https://solscan.io/tx/${tx}`;
export const RHSCAN = (tx: string) => `https://robinhoodchain.blockscout.com/tx/${tx}`;
