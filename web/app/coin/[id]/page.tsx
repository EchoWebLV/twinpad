"use client";
import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { API, pct, usd } from "../../../lib/api";
import { Band, Copy, Img, Nav, PONS, PUMP, RHSCAN, SOLSCAN, Status, short } from "../../components/ui";

type Range = "1h" | "6h" | "24h";

interface Side {
  chain: string; venue: string; kind: string; phaseLabel: string; fdv: number; price: number; quoteSymbol: string; quoteDepth: number; progress: number;
  mint?: string; token?: string; taxBps?: number;
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

const INK = "#f1eee6";
const YEL = "#ffd400";

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
        const j = (await r.json()) as StateResp & { error?: string };
        if (!r.ok) throw new Error(j.error ?? r.statusText);
        if (alive) { setS(j); setErr(null); }
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    };
    void tick();
    const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [range, id]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !s) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    c.width = W * dpr; c.height = H * dpr;
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const pts = s.series;
    if (pts.length < 2) { ctx.fillStyle = "#55534d"; ctx.font = "11px 'IBM Plex Mono', monospace"; ctx.fillText("COLLECTING POINTS", 12, 20); return; }
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const lo = Math.min(...pts.map((p) => Math.min(p.pump, p.pons))) * 0.97;
    const hi = Math.max(...pts.map((p) => Math.max(p.pump, p.pons))) * 1.03;
    const x = (t: number) => 8 + ((t - t0) / Math.max(1, t1 - t0)) * (W - 16);
    const y = (v: number) => H - 8 - ((v - lo) / Math.max(1, hi - lo)) * (H - 16);
    ctx.strokeStyle = "rgba(241,238,230,0.06)";
    for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0, (H / 4) * i); ctx.lineTo(W, (H / 4) * i); ctx.stroke(); }
    ctx.fillStyle = "rgba(255,212,0,0.07)";
    ctx.beginPath();
    pts.forEach((p, i) => { const v = Math.min(p.pump, p.pons); i ? ctx.lineTo(x(p.t), y(v)) : ctx.moveTo(x(p.t), y(v)); });
    for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(x(pts[i].t), y(Math.min(pts[i].pump, pts[i].pons) * (1 + s.band)));
    ctx.closePath(); ctx.fill();
    const line = (key: "pump" | "pons", color: string) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = "miter";
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p[key])) : ctx.moveTo(x(p.t), y(p[key]))));
      ctx.stroke();
    };
    line("pump", INK);
    line("pons", YEL);
  }, [s]);

  const live = s?.status === "live";
  const makerState = !s ? "" : !s.maker.enabled ? "disabled" : s.maker.halted ? "halted" : s.maker.running ? "running" : "idle";
  return (
    <div className="shell">
      <Nav />
      {err && <div className="empty" style={{ marginTop: 40 }}><b>Could not load coin</b>{err}</div>}
      {s && (
        <>
          <div className="ph-row r">
            <Img src={s.meta?.image} size={76} />
            <div>
              <h1>{s.meta?.name ?? id}<small>${s.meta?.symbol ?? ""}</small></h1>
              <p className="desc">{s.meta?.description}</p>
            </div>
            <Status status={live ? "live" : "launching"} />
          </div>

          <section className="grid3c">
            <SideCard side={s.pump} cls="pump" i={1} ca={s.pair?.pumpMint} link={s.pair ? PUMP(s.pair.pumpMint) : undefined} />
            <div className="box needle r" style={{ "--i": 2 } as React.CSSProperties}>
              <span className="up mute">gap</span>
              <div className={`gap ${s.inBand == null ? "" : s.inBand ? "y" : "red"}`}>{s.gap == null ? "—" : pct(s.gap)}</div>
              {s.expensive ? <span className="up mute">{s.expensive} higher</span> : <span className="up dim">band {pct(s.band)}</span>}
              <div style={{ alignSelf: "stretch" }}><Band gap={s.gap} pumpFdv={s.pump?.fdv ?? null} ponsFdv={s.pons?.fdv ?? null} band={s.band} big /></div>
            </div>
            <SideCard side={s.pons} cls="pons" i={3} ca={s.pair?.ponsToken} link={s.pair ? PONS(s.pair.ponsToken) : undefined} />
          </section>

          <div className="spacer" />
          <div className="box r" style={{ "--i": 4 } as React.CSSProperties}>
            <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 14, flexWrap: "wrap" }}>
              <h2 style={{ margin: 0 }}>FDV · both chains</h2>
              <div className="legend"><span><i style={{ background: INK }} />pump.fun</span><span><i style={{ background: YEL }} />Pons</span><span><i style={{ background: "rgba(255,212,0,0.35)" }} />band</span></div>
              <div className="ranges" style={{ marginLeft: "auto" }}>
                {(["1h", "6h", "24h"] as Range[]).map((r) => <button key={r} className={r === range ? "on" : ""} onClick={() => setRange(r)}>{r}</button>)}
              </div>
            </div>
            <canvas ref={canvas} />
          </div>
          <div className="stats4 r" style={{ "--i": 5 } as React.CSSProperties}>
            <div className="cell"><span>in band</span><b className={s.stats.inBandPct >= 90 ? "y" : ""}>{s.stats.inBandPct}%</b></div>
            <div className="cell"><span>max gap</span><b>{pct(s.stats.maxGap)}</b></div>
            <div className="cell"><span>high</span><b>{usd(s.stats.high)}</b></div>
            <div className="cell"><span>low</span><b>{usd(s.stats.low)}</b></div>
          </div>

          <div className="spacer" />
          <div className="box r" style={{ "--i": 6 } as React.CSSProperties}>
            <div className="tags" style={{ marginBottom: 16 }}>
              <h2 style={{ margin: 0 }}>Market maker</h2>
              <span className={`st ${makerState === "running" ? "live" : makerState === "halted" ? "bad" : "off"}`}>{makerState}{s.maker.halted && s.maker.haltReason ? ` · ${s.maker.haltReason}` : ""}</span>
              <span className="up mute">{s.maker.trades} trades</span>
              {s.inventory && (
                <>
                  <span className="up mute">{s.inventory.solana.sol.toFixed(3)} SOL · {Math.round(s.inventory.solana.tokens).toLocaleString()} tokens</span>
                  <span className="up mute">{s.inventory.evm.eth.toFixed(4)} ETH · {Math.round(s.inventory.evm.tokens).toLocaleString()} tokens · escrow {s.inventory.evm.escrowEth.toFixed(4)}</span>
                </>
              )}
            </div>
            {s.trades.length === 0 ? (
              <p className="mute">No trades yet. The maker only acts when the gap leaves the band.</p>
            ) : (
              <table className="tbl">
                <thead><tr><th>time</th><th>side</th><th>action</th><th>amount</th><th>reason</th><th>tx</th></tr></thead>
                <tbody>
                  {[...s.trades].reverse().slice(0, 20).map((t, i) => (
                    <tr key={i}>
                      <td className="mono">{new Date(t.t).toLocaleTimeString()}</td>
                      <td><span className={`up ${t.side === "pons" ? "y" : ""}`}>{t.side}</span></td>
                      <td><b className={t.action === "buy" ? "y" : "red"}>{t.action}</b></td>
                      <td><b>{t.amount}</b></td>
                      <td className={t.error ? "err" : ""}>{t.error ?? t.reason}</td>
                      <td>{t.tx ? <a className="lnk" href={t.side === "pump" ? SOLSCAN(t.tx) : RHSCAN(t.tx)} target="_blank" rel="noreferrer">view ↗</a> : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="foot"><span>fx SOL ${s.fx.SOL} · ETH ${s.fx.ETH}</span><span>updated {new Date(s.updatedAt).toLocaleTimeString()} · read errors pump {s.errors.pump} / pons {s.errors.pons}</span></div>
        </>
      )}
    </div>
  );
}

function SideCard({ side, cls, i, ca, link }: { side: Side | null; cls: "pump" | "pons"; i: number; ca?: string; link?: string }) {
  const title = cls === "pump" ? "Solana · pump.fun" : "Robinhood Chain · Pons";
  if (!side) return <div className={`box venue ${cls} r`} style={{ "--i": i } as React.CSSProperties}><span className="cap">{title}</span><p className="mute"><i className="ld" />waiting for data</p></div>;
  return (
    <div className={`box venue ${cls} r`} style={{ "--i": i } as React.CSSProperties}>
      <span className="cap">{title}</span>
      <div className="head"><span className="up mute">{side.venue} · {side.phaseLabel}</span></div>
      <div className="fdv">{usd(side.fdv)}</div>
      <div className="kv"><span>price</span><b>${side.price.toPrecision(4)}</b></div>
      <div className="kv"><span>{side.progress < 1 ? "quote in curve" : "quote in pool"}</span><b>{side.quoteDepth.toFixed(2)} {side.quoteSymbol}</b></div>
      {side.taxBps != null && <div className="kv"><span>creator tax</span><b>{side.taxBps / 100}%</b></div>}
      <div className="bar"><i style={{ width: `${Math.round(side.progress * 100)}%` }} /></div>
      <div className="kv"><span>graduation</span><b>{Math.round(side.progress * 100)}%</b></div>
      {ca && (
        <div className="addr" style={{ marginBottom: 0 }}>
          <code>{short(ca, 8)}</code>
          <Copy text={ca} />
          {link && <a className="btn sm" href={link} target="_blank" rel="noreferrer">trade ↗</a>}
        </div>
      )}
    </div>
  );
}
