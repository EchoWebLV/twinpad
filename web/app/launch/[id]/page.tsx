"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getJson, img, postJson, usd, type Launch } from "../../../lib/api";
import { Copy, Img, Nav, PONS, PUMP, RHSCAN, SOLSCAN, Status, short } from "../../components/ui";
import { useWallets, type DetectedWallet } from "../../../lib/wallet";

const STEPS: { key: string; title: string; desc: string }[] = [
  { key: "created", title: "Created", desc: "Metadata pinned, wallets generated" },
  { key: "status:paid", title: "Deposit received", desc: "Watcher confirmed your deposit" },
  { key: "status:approved", title: "Approved", desc: "Cleared for launch" },
  { key: "fronting", title: "Pool fronted", desc: "Maker wallets funded on both chains" },
  { key: "deposit_to_pool", title: "Deposit swept", desc: "Your deposit moved into the pool" },
  { key: "pump_create", title: "pump.fun live", desc: "Token created, dev buy done" },
  { key: "pons_launch", title: "Pons live", desc: "Token launched on Robinhood Chain" },
  { key: "launched", title: "Maker sized", desc: "Both sides opened at the same FDV" },
  { key: "status:live", title: "Live", desc: "Market maker holding the band" },
];

export default function LaunchPage() {
  const { id } = useParams<{ id: string }>();
  const [l, setL] = useState<Launch | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [payErr, setPayErr] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [hash, setHash] = useState("");
  const wallets = useWallets();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = () => { setNow(Date.now()); getJson<Launch>(`/api/paid/${id}`).then((x) => { setL(x); setErr(null); }).catch((e) => setErr((e as Error).message)); };
    tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, [id]);
  const pay = async (w: DetectedWallet) => {
    if (!l) return;
    setPaying(true);
    setPayErr(null);
    try {
      const sig = await w.pay(l.devWallet, l.payment.address, l.payment.required);
      setSent(sig);
      if (l.payment.chain === "eth") setL(await postJson<Launch>(`/api/paid/${id}/tx`, { hash: sig }));
    } catch (e) {
      setPayErr((e as Error).message);
    }
    setPaying(false);
  };
  const submitHash = async (e: React.FormEvent) => {
    e.preventDefault();
    setPayErr(null);
    try {
      setL(await postJson<Launch>(`/api/paid/${id}/tx`, { hash: hash.trim() }));
      setSent(hash.trim());
      setHash("");
    } catch (er) {
      setPayErr((er as Error).message);
    }
  };
  if (err) return <div className="shell"><Nav /><div className="empty" style={{ marginTop: 40 }}><b>Could not load launch</b>{err}</div></div>;
  if (!l) return <div className="shell"><Nav /><p className="mute" style={{ marginTop: 40 }}><i className="ld" />loading</p></div>;

  const done = new Set<string>(l.launch.steps.map((s) => s.name));
  const stepNames = new Set(l.launch.steps.map((s) => s.name));
  if (stepNames.has("pons_sizing") || stepNames.has("launched")) done.add("pons_launch");
  if (stepNames.has("pons_sizing") || stepNames.has("launched") || l.launch.pumpMint) done.add("pump_create");
  const rank = (s: string) => ["awaiting_deposit", "paid", "approved", "launching", "live"].indexOf(s);
  if (rank(l.status) >= rank("paid")) done.add("status:paid");
  if (rank(l.status) >= rank("approved")) done.add("status:approved");
  if (l.status === "live") done.add("status:live");
  const firstOpen = STEPS.findIndex((s) => !done.has(s.key));
  const stepAt = (k: string) => l.launch.steps.find((s) => s.name === k)?.at;
  const remaining = Math.max(0, l.payment.deadlineAt - now);
  const terminal = ["rejected", "expired", "failed"].includes(l.status);
  const R = l.retire;
  const exitRule = R
    ? `By ${new Date(R.decideAt).toLocaleTimeString()} the coin needs ${R.policy.minBuyers} outside holders or $${R.policy.minUsd} held by outsiders across both chains. Below that the pool exits: instantly when nobody bought, otherwise sold down over ${R.policy.selldownMin} min at or above the opening price.`
    : null;
  const isEth = l.payment.chain === "eth";
  const unit = l.payment.unit;
  const scan = isEth ? RHSCAN : SOLSCAN;
  const chainName = isEth ? "Robinhood Chain" : "Solana";
  const payWith = wallets.filter((w) => w.chain === l.payment.chain);

  return (
    <div className="shell">
      <Nav />
      <div className="ph-row r">
        <Img src={img(l.token.imageCid)} size={76} />
        <div>
          <h1>{l.token.name}<small>${l.token.symbol}</small></h1>
          <p className="desc">{l.token.description}</p>
        </div>
        <Status status={l.status} />
      </div>

      <div className="two">
        <div className="stack">
          {l.status === "awaiting_deposit" && (
            <div className="box on r" style={{ "--i": 1 } as React.CSSProperties}>
              <span className="cap">01 · Pay the deposit</span>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                <div className="pay-amt">{l.payment.required}<small>{unit}</small></div>
                <span className={`st ${remaining < 10 * 60e3 ? "bad" : ""}`}>{Math.floor(remaining / 60000)} min left</span>
              </div>
              <p className="mute">on {chainName}, from <span className="mono">{short(l.devWallet, 6)}</span> to this address:</p>
              <div className="addr"><code>{l.payment.address}</code><Copy text={l.payment.address} /></div>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center", marginTop: 14 }}>
                {payWith.map((w) => (
                  <button key={w.key} className="btn y" onClick={() => pay(w)} disabled={paying}>
                    {w.icon && <img src={w.icon} alt="" style={{ width: 16, height: 16, marginRight: 8, verticalAlign: -3 }} />}{paying ? "Waiting for wallet" : `Pay with ${w.name}`} <span className="ar">→</span>
                  </button>
                ))}
                {payWith.length === 0 && <span className="mute" style={{ fontSize: 13 }}>No {chainName} wallet detected here. Send the {unit} from your wallet to the address above.</span>}
                <span className="up mute">received {l.payment.received} / {l.payment.required} {unit}</span>
                {isEth && l.payment.claimed.length > 0 && <span className="up y">verifying {l.payment.claimed.length} tx</span>}
              </div>
              {sent && <p className="mute" style={{ marginTop: 12 }}>Sent · <a className="lnk y" href={scan(sent)} target="_blank" rel="noreferrer">view tx ↗</a> · the watcher confirms it within a few seconds.</p>}
              {payErr && <p className="err" style={{ marginTop: 12 }}>{payErr}</p>}
              {isEth && (
                <form className="hashrow" onSubmit={submitHash}>
                  <input placeholder="Paid from the wallet directly? Paste the tx hash (0x…)" value={hash} onChange={(e) => setHash(e.target.value)} />
                  <button className="btn sm" disabled={!/^0x[0-9a-fA-F]{64}$/.test(hash.trim())}>Submit</button>
                </form>
              )}
              <p className="dim" style={{ marginTop: 14, fontSize: 12 }}>
                Only the wallet above counts. Payments from other wallets and payments after the deadline are refunded automatically.
                {isEth && " ETH payments are credited from the tx hash: the page submits it after your wallet sends, or paste it above."}
              </p>
            </div>
          )}
          {l.status === "live" && (
            <div className="box on r">
              <span className="cap">Live</span>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
                <a className="btn y" href={`/coin/${l.id}`}>Open the live view <span className="ar">→</span></a>
                <a className="lnk" href={PUMP(l.wallets.pumpMint)} target="_blank" rel="noreferrer">pump.fun ↗</a>
                {l.launch.ponsToken && <a className="lnk" href={PONS(l.launch.ponsToken)} target="_blank" rel="noreferrer">Pons ↗</a>}
              </div>
              <p className="mute" style={{ marginTop: 12 }}>
                Front recovered: {l.front.repaidSol.toFixed(3)} of {l.front.sol} SOL · {l.front.repaidEth.toFixed(4)} of {l.front.eth} ETH
                {l.front.topupEth > 0 && <> (incl. {l.front.topupEth} ETH topped up)</>}
                {l.front.retiredAt && <> · <span className="y">front retired</span></>}
              </p>
              {R && (
                <p className="dim" style={{ marginTop: 14, fontSize: 12 }}>
                  {R.keep
                    ? "Exit timer off: the operator is keeping this coin."
                    : R.evaluated?.verdict === "keep"
                      ? `Passed the interest check with ${R.evaluated.outsideBuyers} outside holders and $${R.evaluated.outsideUsd.toFixed(0)} held. The maker stays.`
                      : R.evaluated?.verdict === "selldown"
                        ? `Interest check missed (${R.evaluated.outsideBuyers} outside holders, $${R.evaluated.outsideUsd.toFixed(0)} held). The pool is selling down until ${R.selldownUntil ? new Date(R.selldownUntil).toLocaleTimeString() : "soon"}, then closes.`
                        : exitRule}
                </p>
              )}
            </div>
          )}
          {(l.status === "closing" || l.status === "closed") && (
            <div className="box r">
              <h2>{l.status === "closed" ? "Closed" : "Closing"}</h2>
              <p className="mute">{R?.reason ?? "The pool is exiting this coin."}</p>
              {R && R.evaluated && <p className="mute" style={{ marginTop: 8 }}>Interest check: {R.evaluated.outsideBuyers} outside holders, ${R.evaluated.outsideUsd.toFixed(0)} held (needed {R.policy.minBuyers} or ${R.policy.minUsd}).</p>}
              {(l.front.repaidSol > 0 || l.front.repaidEth > 0) && <p className="mute" style={{ marginTop: 8 }}>Recovered {l.front.repaidSol.toFixed(4)} SOL + {l.front.repaidEth.toFixed(5)} ETH of {l.front.sol} SOL + {l.front.eth} ETH fronted{R && (R.swept.sol > 0 || R.swept.eth > 0) ? ` (${R.swept.sol.toFixed(4)} SOL + ${R.swept.eth.toFixed(5)} ETH at close)` : ""}.</p>}
              {l.boostSol > 0 && <p className="mute" style={{ marginTop: 8 }}>Your {l.boostSol} SOL boost: {l.refund.paid > 0 ? `${l.refund.paid} SOL refunded to your wallet` : "refund pending"}.</p>}
              {R?.error && <p className="err">{R.error}</p>}
              <p className="dim" style={{ marginTop: 10, fontSize: 12 }}>The tokens stay tradable on pump.fun and Pons; only the pool's market maker has left.</p>
            </div>
          )}
          {l.status === "launching" && (
            <div className="box on r"><span className="st launching">Launching now</span><p className="mute" style={{ marginTop: 10 }}>Both chains are being set up. This page updates on its own.</p>{exitRule && <p className="dim" style={{ marginTop: 10, fontSize: 12 }}>{exitRule}</p>}</div>
          )}
          {terminal && (
            <div className="box r">
              <h2 className="red">{l.status === "failed" ? "Launch failed" : l.status === "rejected" ? "Rejected" : "Expired"}</h2>
              {l.launch.error && <p className="err">{l.launch.error}</p>}
              {l.approval.note && <p className="mute">{l.approval.note}</p>}
              {l.status === "failed" && <p className="mute" style={{ marginTop: 8 }}>An operator can retry from the checkpoint it stopped at. Nothing is re-spent.</p>}
              {l.refund.txs.length > 0 && <p className="mute" style={{ marginTop: 8 }}>Refunded {l.refund.amount} {unit} · {l.refund.txs.map((t) => <a key={t} className="lnk y" href={scan(t)} target="_blank" rel="noreferrer">tx ↗ </a>)}</p>}
            </div>
          )}

          <div className="box r" style={{ "--i": 2 } as React.CSSProperties}>
            <h2>Progress</h2>
            <ol className="timeline">
              {STEPS.map((s, i) => {
                const isDone = done.has(s.key);
                const isNow = !isDone && i === firstOpen && !terminal;
                const at = stepAt(s.key) ?? (s.key === "created" ? l.createdAt : s.key === "status:paid" ? l.payment.paidAt : s.key === "status:approved" ? l.approval.at : undefined);
                return (
                  <li key={s.key} className={isDone ? "done" : isNow ? "now" : ""}>
                    <span className="tick" />
                    <div><div className="t">{s.title}</div><div className="d">{s.desc}</div></div>
                    <span className="when">{at ? new Date(at).toLocaleTimeString() : ""}</span>
                  </li>
                );
              })}
            </ol>
          </div>

          {l.launch.steps.length > 0 && (
            <div className="box r" style={{ "--i": 3 } as React.CSSProperties}>
              <h2>Log</h2>
              <table className="log">
                <tbody>
                  {[...l.launch.steps].reverse().map((s, i) => (
                    <tr key={i}>
                      <td>{new Date(s.at).toLocaleTimeString()}</td>
                      <td className="k">{s.name}</td>
                      <td className="mono">{Object.entries(s).filter(([k]) => k !== "at" && k !== "name").map(([k, v]) => `${k}=${String(v)}`).join("  ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="sticky stack">
          <div className="box r" style={{ "--i": 2 } as React.CSSProperties}>
            <span className="cap">Addresses</span>
            <div className="kv"><span>pump.fun CA</span><b className="mono">{short(l.wallets.pumpMint, 6)}</b></div>
            <div className="addr" style={{ marginTop: 0 }}><code>{l.wallets.pumpMint}</code><Copy text={l.wallets.pumpMint} /></div>
            {l.launch.ponsToken && (
              <>
                <div className="kv"><span>Pons token</span><b className="mono">{short(l.launch.ponsToken, 6)}</b></div>
                <div className="addr" style={{ marginTop: 0 }}><code>{l.launch.ponsToken}</code><Copy text={l.launch.ponsToken} /></div>
              </>
            )}
            <div className="kv"><span>Your wallet · {chainName}</span><b className="mono">{short(l.devWallet, 6)}</b></div>
            <div className="kv"><span>Maker · Solana</span><b className="mono">{short(l.wallets.solMaker || l.wallets.solCreator, 6)}</b></div>
            <div className="kv"><span>Creator · Solana</span><b className="mono">{short(l.wallets.solCreator, 6)}</b></div>
            <div className="kv"><span>Maker · Robinhood</span><b className="mono">{short(l.wallets.evmMaker, 6)}</b></div>
          </div>
          <div className="box r" style={{ "--i": 3 } as React.CSSProperties}>
            <span className="cap">Sizing</span>
            <div className="kv"><span>Deposit</span><b>{l.payment.required} {unit}</b></div>
            <div className="kv"><span>Pool fronts</span><b>{l.quote.frontSol} SOL + {l.quote.frontEth} ETH</b></div>
            {l.boostSol > 0 && <div className="kv"><span>Your boost</span><b>{l.boostSol} SOL</b></div>}
            <div className="kv"><span>Dev buy</span><b>{l.quote.devBuySol} SOL</b></div>
            <div className="kv"><span>Opening FDV</span><b className="y">{usd(l.quote.openingFdv)}</b></div>
            <div className="kv"><span>Landing</span><b>pump {usd(l.quote.landing.pump)} <span className="dim">/</span> pons {usd(l.quote.landing.pons)}</b></div>
            <div className="kv"><span>Maker inventory</span><b>{l.quote.supplyPct.pump}% · {l.quote.supplyPct.pons}%</b></div>
          </div>
          {(l.token.twitter || l.token.website || l.token.telegram) && (
            <div className="box tags r" style={{ "--i": 4 } as React.CSSProperties}>
              {l.token.twitter && <a className="lnk" href={l.token.twitter} target="_blank" rel="noreferrer">Twitter ↗</a>}
              {l.token.website && <a className="lnk" href={l.token.website} target="_blank" rel="noreferrer">Website ↗</a>}
              {l.token.telegram && <a className="lnk" href={l.token.telegram} target="_blank" rel="noreferrer">Telegram ↗</a>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
