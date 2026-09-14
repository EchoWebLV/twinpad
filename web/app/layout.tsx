import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Twinpad",
  description: "One coin, two chains. Launch on pump.fun and Pons at the same price, held in a 5% band by a market maker.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@700;900&family=IBM+Plex+Mono:wght@300;400;500;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
        {/* enable entrance animations only when the document is visible and actually painting frames; otherwise content renders static */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){if(document.visibilityState!=='visible')return;var t=performance.now();requestAnimationFrame(function(){requestAnimationFrame(function(){if(performance.now()-t<250)document.documentElement.classList.add('anim')})})})();",
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
