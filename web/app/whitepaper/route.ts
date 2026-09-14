import { readFileSync } from "node:fs";
import path from "node:path";

// The whitepaper is one HTML fragment (web/content/whitepaper.html) that carries its own <title>, font link and
// <style>. It is served here as a standalone document so the app's global stylesheet never touches it, and the same
// fragment is what gets published as the claude.ai artifact. Prerendered once at build time.
export const dynamic = "force-static";

const SITE = "https://twinpad.one";
const TITLE = "Twinpad Whitepaper";
const DESCRIPTION =
  "How Twinpad keeps one coin at one price on Solana and Robinhood Chain: the steward rule set, fee buyback and burn, and the simulations behind them.";

export function GET() {
  const fragment = readFileSync(path.join(process.cwd(), "content", "whitepaper.html"), "utf8");
  const at = fragment.indexOf('<div class="wrap">');
  const head = at >= 0 ? fragment.slice(0, at) : "";
  const body = at >= 0 ? fragment.slice(at) : fragment;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${DESCRIPTION}">
<link rel="canonical" href="${SITE}/whitepaper">
<link rel="icon" href="/icon.png">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Twinpad">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESCRIPTION}">
<meta property="og:url" content="${SITE}/whitepaper">
<meta property="og:image" content="${SITE}/logo.png">
<meta name="twitter:card" content="summary_large_image">
${head}</head>
<body>
${body}</body>
</html>
`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
