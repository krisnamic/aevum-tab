import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Instrument_Serif } from "next/font/google";
import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import { Providers } from "./providers";
import "./globals.css";

const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", variable: "--font-serif", display: "swap" });
const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-sans", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono-face", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Tab", template: "%s · Tab" },
  description: "Pay-per-call tabs for AI agents, settled in tUSD8 on QDay Aevum testnet.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <Providers>
          <Header />
          {children}
        </Providers>
      </body>
    </html>
  );
}
