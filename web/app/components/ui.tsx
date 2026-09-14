"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { getJson } from "../../lib/api";

/** Twinpad mark: the cat, half yellow half black — one coin, two chains. */
export function Mark({ size = 30 }: { size?: number }) {
  return <img className="mark" src="/logo.png" width={size} height={size} alt="" />;
}

/**
 * Hero cat: the logo extruded into depth (stacked layers on the z axis), tilting toward the pointer with a slow idle turn.
 * Pure CSS 3D on the one PNG — no model, no WebGL.
 */
const CAT_LAYERS = 22;
export function Cat3D() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let tx = 0, ty = 0, cx = 0, cy = 0;
    const settle = () => {
      cx += (tx - cx) * 0.08;
      cy += (ty - cy) * 0.08;
      el.style.setProperty("--ry", `${cx.toFixed(2)}deg`);
      el.style.setProperty("--rx", `${cy.toFixed(2)}deg`);
      raf = Math.abs(tx - cx) + Math.abs(ty - cy) > 0.05 ? requestAnimationFrame(settle) : 0;
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(settle); };
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - (r.left + r.width / 2)) / Math.max(r.width, 1);
      const y = (e.clientY - (r.top + r.height / 2)) / Math.max(r.height, 1);
      tx = Math.max(-1.2, Math.min(1.2, x)) * 38;
      ty = Math.max(-1.2, Math.min(1.2, -y)) * 26;
      kick();
    };
    const leave = () => { tx = 0; ty = 0; kick(); };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerleave", leave);
    document.addEventListener("mouseleave", leave);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerleave", leave);
      document.removeEventListener("mouseleave", leave);
    };
  }, []);
  return (
    <div className="cat3d" ref={ref} aria-hidden="true">
      <div className="glow" />
      <div className="tilt">
        <div className="stack">
          {Array.from({ length: CAT_LAYERS }, (_, i) => {
            const back = CAT_LAYERS - 1 - i; // 0 = front face
            const shade = back === 0 ? 1 : Math.max(0.12, 0.55 - back * 0.02);
            return (
              <img
                key={i}
                src="/logo.png"
                alt=""
                draggable={false}
                style={{ transform: `translateZ(${-back * 3}px)`, filter: back === 0 ? "none" : `brightness(${shade}) saturate(1.4)` }}
              />
            );
          })}
        </div>
      </div>
      <div className="floor" />
    </div>
  );
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
