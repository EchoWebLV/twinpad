import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Duo Aura Pad",
  description: "One coin, two chains. pump.fun on Solana and Pons on Robinhood Chain, held within a band by a market maker.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
