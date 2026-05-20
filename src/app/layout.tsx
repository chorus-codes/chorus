import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppShellRouter } from "@/components/app-shell-router";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Chorus — many voices, one chorus",
  description:
    "The polished orchestrator over your AI fleet. Paste a task. Pick a template. Watch multiple LLMs reach consensus.",
};

// Without an explicit viewport, mobile browsers default to a 980px layout
// width and zoom out — the cockpit is dense, that scales to unreadable
// text. Setting width=device-width opts into responsive behaviour. The
// app is desktop-first; this just stops mobile from rendering it as a
// shrunken-down desktop screenshot.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

interface RootLayoutProps {
  children: React.ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <AppShellRouter>{children}</AppShellRouter>
      </body>
    </html>
  );
}
