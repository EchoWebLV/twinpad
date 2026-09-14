"use client";
import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { API } from "../../../lib/api";

type Range = "1h" | "6h" | "24h";

interface Side {
  chain: string;
  venue: string;
  kind: string;
  phaseLabel: string;
  fdv: number;
  price: number;
  quoteSymbol: string;
  quoteDepth: number;
  progress: number;
  mint?: string;
  token?: string;
  taxBps?: number;
}
interface StateResp {
  status: string;
  pair: { pumpMint: string; ponsToken: string; ponsCurve: string; launchedAt: number | null; name: string; symbol: string } | null;
  meta: { name: string; symbol: string; image: string; twitter: string; website: string; description: string } | null;
  fx: { SOL: number; ETH: number };
  band: number;
  pump: Side | null;
  pons: Side | null;
  gap: number | null;
  expensive: string | null;
  inBand: boolean | null;
  stats: { range: string; points: number; inBandPct: number; maxGap: number; high: number; low: number };
  series: { t: number; pump: number; pons: number }[];
  inventory: { solana: { sol: number; tokens: number }; evm: { eth: number; tokens: number; escrowEth: number } } | null;
  maker: { enabled: boolean; running: boolean; halted: boolean; haltReason: string | null; trades: number };
  trades: { t: number; side: string; action: string; amount: string; reason: string; tx?: string; error?: string }[];
  updatedAt: number;
  errors: { pump: number; pons: number };
}

const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(0)}`);
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

export default function Page() {
  const { id } = useParams<{ id: string }>();
  const [s, setS] = useState<StateResp | null>(null);
  const [range, setRange] = useState<Range>("24h");
  const [err, setErr] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`${API}/api/coins/${id}/state?range=${range}`, { cache: "no-store" });
        const j = (await r.json()) as StateResp;
        if (alive) {
          setS(j);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [range, id]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !s) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const pts = s.series;
    if (pts.length < 2) {
      ctx.fillStyle = "#8d8d9c";
      ctx.fillText("collecting points…", 12, 20);
      return;
    }
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const lo = Math.min(...pts.map((p) => Math.min(p.pump, p.pons))) * 0.97;
    const hi = Math.max(...pts.map((p) => Math.max(p.pump, p.pons))) * 1.03;
    const x = (t: number) => 8 + ((t - t0) / Math.max(1, t1 - t0)) * (W - 16);
    const y = (v: number) => H - 8 - ((v - lo) / Math.max(1, hi - lo)) * (H - 16);
    // in-band shading around the cheaper side
    ctx.fillStyle = "rgba(55,214,122,0.08)";
    ctx.beginPath();
    pts.forEach((p, i) => { const v = Math.min(p.pump, p.pons); i ? ctx.lineTo(x(p.t), y(v)) : ctx.moveTo(x(p.t), y(v)); });
    for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(x(pts[i].t), y(Math.min(pts[i].pump, pts[i].pons) * (1 + s.band)));
    ctx.closePath();
    ctx.fill();
    const line = (key: "pump" | "pons", color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p[key])) : ctx.moveTo(x(p.t), y(p[key]))));
      ctx.stroke();
    };
    line("pump", "#9945ff");
    line("pons", "#4ea1ff");
  }, [s]);

  const live = s?.status === "live";
  return (
    <main>
      <header>
        <a href="/" className="back">← all coins</a>
        {s?.meta?.image ? <img src={s.meta.image} alt="" /> : <div style={{ width: 56, height: 56 }} />}
        <div>
          <h1>{s?.meta ? `${s.meta.name} · $${s.meta.symbol}` : "Duo Aura Pad"}</h1>
          <div className="sub">{s?.meta?.description ?? "One coin, two chains. pump.fun on Solana and Pons on Robinhood Chain, held within a band by a market maker."}</div>
        </div>
        <span className={`status ${live ? "live" : ""}`}>{s?.status ?? (err ? "offline" : "…")}</span>
      </header>

      {err && <p className="err">API unreachable at {API}: {err}</p>}

      {s && (
        <>
          <section className="grid">
            <SideCard side={s.pump} cls="sol" ca={s.pair?.pumpMint} link={s.pair ? `https://pump.fun/coin/${s.pair.pumpMint}` : undefined} />
            <div className="needle card">
              <small>gap</small>
              <div className={`gap ${s.inBand ? "ok" : "bad"}`}>{s.gap == null ? "—" : pct(s.gap)}</div>
              <small>band {pct(s.band)}</small>
              <small>{s.expensive ? `${s.expensive} expensive` : ""}</small>
            </div>
            <SideCard side={s.pons} cls="eth" ca={s.pair?.ponsToken} link={s.pair ? `https://ponsfamily.com/token/${s.pair.ponsToken}` : undefined} />
          </section>

          <div className="ranges">
            {(["1h", "6h", "24h"] as Range[]).map((r) => (
              <button key={r} className={r === range ? "on" : ""} onClick={() => setRange(r)}>{r}</button>
            ))}
          </div>
          <div className="card"><canvas ref={canvas} /></div>
          <div className="stats">
            <div><span>in band</span>{s.stats.inBandPct}%</div>
            <div><span>max gap</span>{pct(s.stats.maxGap)}</div>
            <div><span>high</span>{usd(s.stats.high)}</div>
            <div><span>low</span>{usd(s.stats.low)}</div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h2>Maker</h2>
            <div className="venue">
              {s.maker.enabled ? (s.maker.halted ? `halted: ${s.maker.haltReason}` : s.maker.running ? "running" : "idle") : "disabled"} · {s.maker.trades} trades
              {s.inventory && ` · ${s.inventory.solana.sol.toFixed(3)} SOL / ${s.inventory.solana.tokens.toLocaleString()} tokens · ${s.inventory.evm.eth.toFixed(4)} ETH / ${s.inventory.evm.tokens.toLocaleString()} tokens · escrow ${s.inventory.evm.escrowEth.toFixed(4)} ETH`}
            </div>
            <table>
              <thead><tr><th>time</th><th>side</th><th>action</th><th>amount</th><th>reason</th><th>tx</th></tr></thead>
              <tbody>
                {[...s.trades].reverse().slice(0, 20).map((t, i) => (
                  <tr key={i}>
                    <td>{new Date(t.t).toLocaleTimeString()}</td><td>{t.side}</td><td>{t.action}</td><td>{t.amount}</td>
                    <td className={t.error ? "err" : ""}>{t.error ?? t.reason}</td>
                    <td>{t.tx ? <a href={t.side === "pump" ? `https://solscan.io/tx/${t.tx}` : `https://robinhoodchain.blockscout.com/tx/${t.tx}`} target="_blank">tx</a> : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="foot">fx SOL ${s.fx.SOL} · ETH ${s.fx.ETH} · updated {new Date(s.updatedAt).toLocaleTimeString()} · read errors pump {s.errors.pump} / pons {s.errors.pons}</p>
        </>
      )}
    </main>
  );
}

function SideCard({ side, cls, ca, link }: { side: Side | null; cls: string; ca?: string; link?: string }) {
  if (!side) return <div className={`card ${cls}`}><h2>{cls === "sol" ? "Solana · pump.fun" : "Robinhood Chain · PONS"}</h2><div className="venue">waiting for data</div></div>;
  return (
    <div className={`card ${cls}`}>
      <h2>{side.chain} · {side.venue}</h2>
      <div className="venue">{side.phaseLabel}</div>
      <div className="big">{usd(side.fdv)}</div>
      <div className="row"><span>price</span><b>${side.price.toPrecision(4)}</b></div>
      <div className="row"><span>{side.progress < 1 ? "quote in curve" : "quote in pool"}</span><b>{side.quoteDepth.toFixed(2)} {side.quoteSymbol}</b></div>
      {side.taxBps != null && <div className="row"><span>creator tax</span><b>{side.taxBps / 100}%</b></div>}
      <div className="bar"><i style={{ width: `${Math.round(side.progress * 100)}%` }} /></div>
      <div className="row"><span>graduation</span><b>{Math.round(side.progress * 100)}%</b></div>
      {ca && <div className="ca">{ca}{link && <> · <a href={link} target="_blank">trade</a></>}</div>}
    </div>
  );
}
