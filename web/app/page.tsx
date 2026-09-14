"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getJson, img, pct, usd, type CoinSummary, type Launch, type Quote } from "../lib/api";
import { Band, Img, Nav, PONS, PUMP, Sh, Status, Ticker, ago } from "./components/ui";

const OPEN = ["awaiting_deposit", "paid", "approved", "launching"];

export default function Home() {
  const router = useRouter();
  const [coins, setCoins] = useState<CoinSummary[]>([]);
  const [launches, setLaunches] = useState<Launch[]>([]);
  const [q, setQ] = useState<Quote | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const tick = async () => {
      try {
        const [c, l, qq] = await Promise.all([getJson<CoinSummary[]>("/api/coins"), getJson<Launch[]>("/api/paid"), getJson<Quote>("/api/paid/quote")]);
        setCoins(c);
        setLaunches(l);
        setQ(qq);
        setErr(null);
      } catch (e) {
        setErr((e as Error).message);
      }
    };
    void tick();
    const id = setInterval(tick, 10_000);
    return () => clearInterval(id);
  }, []);
  const byId = new Map(coins.map((c) => [c.id, c]));
  const queue = launches.filter((l) => OPEN.includes(l.status));
  const launched = launches.filter((l) => l.status === "live" || l.launch.steps.some((s) => s.name === "launched"));
  const other = launches.filter((l) => ["failed", "rejected", "expired"].includes(l.status) && !launched.includes(l));

  const tick: React.ReactNode[] = [];
  if (q) {
    tick.push(<>SOL <b>${q.fx.SOL.toFixed(0)}</b></>, <>ETH <b>${q.fx.ETH.toFixed(0)}</b></>, <>deposit <b>{q.depositSol} SOL</b></>, <>opening fdv <em>{usd(q.openingFdv)}</em></>);
  }
  for (const c of coins) tick.push(<>{c.symbol} <b>{c.pumpFdv ? usd(c.pumpFdv) : "—"}</b> / <b>{c.ponsFdv ? usd(c.ponsFdv) : "—"}</b> <em>{c.gap == null ? "" : pct(c.gap)}</em></>);
  if (tick.length === 0) tick.push(<>{err ? `api unreachable · ${err}` : "connecting"}</>);

  return (
    <div className="shell">
      <Nav />
      <Ticker items={tick} />
      <section className="hero">
        <div>
          <div className="eyebrow r"><span className="pulse-sq" /><span className="up mute">pump.fun × Pons v2 · one deposit</span></div>
          <h1><span>One coin.</span><span>Two chains.</span><span>Same price.</span></h1>
          <p className="lead r" style={{ "--i": 3 } as React.CSSProperties}>
            Pay one deposit. The pool fronts the maker on both sides, your token goes live on pump.fun and Pons in the same minute,
            and a market maker holds the two prices inside a 5% band.
          </p>
          <div className="cta r" style={{ "--i": 4 } as React.CSSProperties}>
            <a className="btn y" href="/launch">Launch a coin <span className="ar">→</span></a>
            <a className="lnk" href="#how">How it works</a>
          </div>
        </div>
        <div className="box on r" style={{ "--i": 2, padding: 0 } as React.CSSProperties}>
          <span className="cap">Live quote</span>
          {q ? (
            <div className="quote">
              <div className="cell"><span>Your deposit</span><b>{q.depositSol} SOL</b><small>≈ {usd(q.depositSol * q.fx.SOL)}</small></div>
              <div className="cell y"><span>Opening FDV</span><b>{usd(q.openingFdv)}</b><small>both chains</small></div>
              <div className="cell"><span>Pool fronts · Solana</span><b>{q.frontSol} SOL</b><small>{q.devBuySol} SOL dev buy · {q.supplyPct.pump}% supply</small></div>
              <div className="cell"><span>Pool fronts · Robinhood</span><b>{q.frontEth} ETH</b><small>{q.ponsEth} ETH maker buy · {q.supplyPct.pons}% supply</small></div>
            </div>
          ) : (
            <p className="mute" style={{ padding: 22 }}>{err ? `API unreachable: ${err}` : <><i className="ld" />loading quote</>}</p>
          )}
        </div>
      </section>

      <div className="strip r" style={{ "--i": 5 } as React.CSSProperties}>
        <div className="cell"><span>Coins launched</span><b>{launched.length}</b></div>
        <div className="cell"><span>Live now</span><b className={coins.length ? "y" : ""}>{coins.length}</b></div>
        <div className="cell"><span>In queue</span><b>{queue.length}</b></div>
        <div className="cell"><span>In band</span><b>{coins.length ? `${coins.filter((c) => c.inBand).length}/${coins.length}` : "—"}</b></div>
      </div>

      <section className="section">
        <Sh n="01" title="Live now" sub={`${coins.length} with an active maker`} />
        {coins.length === 0 ? (
          <div className="empty"><b>No live coins yet</b>The first launch shows up here with both prices and the gap.</div>
        ) : (
          <div className="coins">
            {coins.map((c, i) => <CoinCard key={c.id} c={c} i={i} />)}
          </div>
        )}
      </section>

      <section className="section">
        <Sh n="02" title="Launched" sub="every coin this pad has put on both chains" />
        {launched.length === 0 ? (
          <div className="empty"><b>Nothing launched yet</b>Launched coins are listed here with their pump.fun and Pons addresses.</div>
        ) : (
          <div>
            <div className="list-head"><span /><span>Coin</span><span className="hide">Opening FDV</span><span className="hide">Now</span><span>Launched</span><span className="hide" style={{ textAlign: "right" }}>Trade</span></div>
            <div className="list">
              {launched.map((l) => {
                const c = byId.get(l.id);
                const launchedAt = (l.launch.steps.find((s) => s.name === "launched")?.at as number | undefined) ?? l.createdAt;
                return (
                  <div key={l.id} className="rowc" role="link" tabIndex={0} onClick={() => router.push(c ? `/coin/${l.id}` : `/launch/${l.id}`)}>
                    <Img src={img(l.token.imageCid)} size={44} />
                    <div><div className="name">{l.token.name} <span className="mute">${l.token.symbol}</span></div><div className="sub"><Status status={l.status} /></div></div>
                    <div className="hide"><span className="lbl">opening</span><span className="num">{usd(l.quote.openingFdv)}</span></div>
                    <div className="hide"><span className="lbl">pump / pons</span><span className="num">{c?.pumpFdv ? usd(c.pumpFdv) : "—"} <span className="dim">/</span> <span className="y">{c?.ponsFdv ? usd(c.ponsFdv) : "—"}</span></span></div>
                    <div><span className="lbl">{new Date(launchedAt).toLocaleDateString()}</span><span className="num">{ago(launchedAt)}</span></div>
                    <div className="out hide">
                      <a className="lnk" href={PUMP(l.wallets.pumpMint)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>pump.fun ↗</a>
                      {l.launch.ponsToken && <a className="lnk" href={PONS(l.launch.ponsToken)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Pons ↗</a>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      <section className="section">
        <Sh n="03" title="Queue" sub="deposits, approvals and launches in progress" />
        {queue.length === 0 ? (
          <div className="empty"><b>Queue is empty</b>Submit a launch and it appears here while the deposit and launch go through.</div>
        ) : (
          <div className="list">
            {queue.map((l) => (
              <a key={l.id} className="rowc" href={`/launch/${l.id}`}>
                <Img src={img(l.token.imageCid)} size={44} />
                <div><div className="name">{l.token.name} <span className="mute">${l.token.symbol}</span></div><div className="sub">{l.wallets.pumpMint.slice(0, 10)}…</div></div>
                <div className="hide"><span className="lbl">deposit</span><span className="num">{l.payment.received}/{l.payment.required} {l.payment.unit}</span></div>
                <div className="hide"><span className="lbl">opening</span><span className="num">{usd(l.quote.openingFdv)}</span></div>
                <div><span className="lbl">{ago(l.createdAt)}</span><Status status={l.status} /></div>
                <div className="out hide" />
              </a>
            ))}
          </div>
        )}
      </section>

      {other.length > 0 && (
        <section className="section">
          <Sh n="04" title="Did not launch" sub="rejected, expired or failed" />
          <div className="list">
            {other.map((l) => (
              <a key={l.id} className="rowc" href={`/launch/${l.id}`}>
                <Img src={img(l.token.imageCid)} size={44} />
                <div><div className="name">{l.token.name} <span className="mute">${l.token.symbol}</span></div><div className="sub">{l.launch.error ?? l.approval.note ?? ""}</div></div>
                <div className="hide" /><div className="hide" />
                <div><span className="lbl">{ago(l.createdAt)}</span><Status status={l.status} /></div>
                <div className="out hide" />
              </a>
            ))}
          </div>
        </section>
      )}

      <section className="section" id="how">
        <Sh n={other.length ? "05" : "04"} title="How it works" />
        <div className="how">
          <div className="step"><div className="n">01</div><h3>Submit</h3><p>Name, symbol, image, socials. Metadata is pinned to IPFS and your pump.fun address is known before anything is spent.</p></div>
          <div className="step"><div className="n">02</div><h3>Deposit</h3><p>Send {q ? `${q.depositSol} SOL` : "the deposit"} from your wallet to a fresh payment address. Wrong-wallet or late payments are refunded automatically.</p></div>
          <div className="step"><div className="n">03</div><h3>Launch</h3><p>The pool fronts the maker on both chains. pump.fun create + dev buy, then Pons launch sized to open at the same FDV.</p></div>
          <div className="step"><div className="n">04</div><h3>Hold the band</h3><p>A market maker watches both prices and trades whenever they drift more than 5% apart.</p></div>
        </div>
      </section>
      <div className="foot"><span>Twinpad</span><span>pump.fun on Solana · Pons v2 on Robinhood Chain 4663</span></div>
    </div>
  );
}

function CoinCard({ c, i }: { c: CoinSummary; i: number }) {
  return (
    <a className="box hot coin r" style={{ "--i": i } as React.CSSProperties} href={`/coin/${c.id}`}>
      <div className="top">
        <Img src={c.image} size={56} />
        <div><div className="name">{c.name}</div><div className="sym">${c.symbol}{c.launchedAt ? ` · ${ago(c.launchedAt)}` : ""}</div></div>
        <Status status={c.maker === "halted" ? "failed" : "live"} />
      </div>
      <div className="sides">
        <div className="side pump"><span>pump.fun</span><b>{c.pumpFdv ? usd(c.pumpFdv) : "—"}</b></div>
        <div className="gapbox">gap<b className={c.inBand == null ? "" : c.inBand ? "y" : "red"}>{c.gap == null ? "—" : pct(c.gap)}</b></div>
        <div className="side pons"><span>Pons</span><b>{c.ponsFdv ? usd(c.ponsFdv) : "—"}</b></div>
      </div>
      <Band gap={c.gap} pumpFdv={c.pumpFdv} ponsFdv={c.ponsFdv} />
    </a>
  );
}
