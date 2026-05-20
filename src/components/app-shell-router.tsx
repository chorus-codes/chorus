"use client";

import { usePathname } from "next/navigation";
import { AppShell } from "./app-shell";

/**
 * Routes that opt OUT of the app shell (sidebar + mobile top bar).
 *
 * Onboarding is the only standalone flow — it deliberately removes the
 * sidebar so the user's first chorus experience is a focused setup
 * wizard, not a chrome-heavy editor frame. Add new routes here when
 * they need the same standalone treatment.
 */
const STANDALONE_ROUTES: ReadonlyArray<string> = ["/onboarding"];

interface AppShellRouterProps {
  children: React.ReactNode;
}

/**
 * Decides whether the current route gets wrapped in the app shell.
 *
 * Lives in root layout.tsx so the shell (and the sidebar inside it) is
 * a SIBLING of every page component, not a child. Result: navigating
 * between pages does NOT unmount the sidebar — `useState` survives,
 * the chat list stays populated, the SSE stream stays connected.
 *
 * Before this routing layer existed, each page rendered its own
 * `<AppShell>` wrapper. Every route navigation unmounted the previous
 * page (sidebar included) and mounted a fresh one — `useState("loading")`
 * re-initialised, the recent-chats list flashed "Loading…" for the
 * duration of the next fetch, and the SSE subscription was torn down
 * and rebuilt. Fixing this by moving the shell here keeps the sidebar
 * a single long-lived instance.
 */
export function AppShellRouter({ children }: AppShellRouterProps) {
  // usePathname() returns `null` during the brief client-render window
  // before App Router has hydrated. Coalescing to "" makes `startsWith`
  // safe and falls through to the wrapped (sidebar-present) branch by
  // default — better than crashing the entire shell with a TypeError.
  // PR #75 audit caught this (opencode-cli-2 finding #1, HIGH).
  const pathname = usePathname() ?? "";
  const standalone = STANDALONE_ROUTES.some((p) =>
    p === pathname || pathname.startsWith(`${p}/`),
  );
  if (standalone) return <>{children}</>;
  return <AppShell>{children}</AppShell>;
}
