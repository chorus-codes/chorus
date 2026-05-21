"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Layers,
  Plug,
  Settings,
  Plus,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
  ArrowUpCircle,
} from "lucide-react";
import { TriadLogo } from "@/components/triad-logo";
import { listChats } from "@/lib/api";
import { chatDisplayTitle } from "@/lib/chat-title";
import {
  readCollapsed,
  writeCollapsed,
} from "@/lib/sidebar-collapsed-storage";
import type { Chat } from "@/lib/types";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV: NavItem[] = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/runs", label: "Runs", icon: ListChecks },
  { href: "/templates", label: "Templates", icon: Layers },
  { href: "/personas", label: "Personas", icon: Users },
  { href: "/connect", label: "Connect", icon: Plug },
  // Settings sits with the rest of the primary nav (under Connect) —
  // pinned to the footer made it look optional and pushed it below
  // the Recent chats list, where users couldn't find it.
  { href: "/settings", label: "Settings", icon: Settings },
];

const STATUS_DOT: Record<Chat["status"], string> = {
  drafting: "bg-amber-400",
  reviewing: "bg-primary animate-pulse-soft",
  approved: "bg-emerald-400",
  no_review: "bg-amber-400",
  merged: "bg-emerald-500",
  blocked: "bg-amber-500 animate-pulse-soft",
  cancelled: "bg-muted-foreground",
  failed: "bg-destructive",
};

interface SidebarBodyProps {
  onNavigate?: () => void;
  /** True when sidebar is collapsed to icons-only (~56px wide). */
  collapsed?: boolean;
  /** Toggle collapsed state. Optional — undefined hides the toggle button. */
  onToggleCollapsed?: () => void;
}

/**
 * Inner sidebar content — used by both the desktop fixed sidebar
 * and the mobile Sheet overlay (see MobileNav).
 */
export function SidebarBody({ onNavigate, collapsed = false, onToggleCollapsed }: SidebarBodyProps) {
  const pathname = usePathname();
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatsState, setChatsState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  // Read the daemon version from /health on mount instead of hardcoding the
  // sidebar badge. Fixes a class of drift bug where bumping package.json +
  // CLI + daemon constants still left the cockpit showing the old version
  // because the literal in this file was never updated. /health is cached
  // for the session — single fetch on mount.
  const [daemonVersion, setDaemonVersion] = useState<string | null>(null);
  // Update-available banner. Daemon caches the npm dist-tag for 4h so a
  // single fetch on mount is enough — cockpit reloads pick up the latest
  // value within one TTL of an upstream release.
  const [updateInfo, setUpdateInfo] = useState<{
    latest: string;
    current: string;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/daemon/api/v1/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        const v = j?.data?.version ?? j?.version;
        if (typeof v === "string" && v.length > 0) setDaemonVersion(v);
      })
      .catch(() => {
        /* offline daemon — fall back to the placeholder */
      });
    fetch("/api/daemon/api/v1/update-check")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j?.data?.updateAvailable) return;
        const { current, latest } = j.data;
        if (typeof current === "string" && typeof latest === "string") {
          setUpdateInfo({ current, latest });
        }
      })
      .catch(() => {
        /* offline / npm unreachable — silent */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Monotonic sequence so a slow earlier request can't overwrite the
    // result of a later one. Multiple triggers (mount, SSE event,
    // visibility change, 2s poll) can fire concurrently — without
    // this, the slowest reply lands last and the sidebar shows stale
    // data even after a fresher fetch already returned. PR #77 audit
    // followup.
    let reqSeq = 0;
    let latestSeq = 0;

    const fetchChats = async () => {
      const mySeq = ++reqSeq;
      try {
        const list = await listChats({ limit: 12 });
        if (cancelled) return;
        if (mySeq < latestSeq) return; // a newer request already won
        latestSeq = mySeq;
        setChats(list);
        setChatsState("ready");
      } catch {
        if (cancelled) return;
        if (mySeq < latestSeq) return;
        // Same display for known daemon-down vs unexpected errors —
        // the dead `instanceof DaemonError` ternary that used to live
        // here had both branches equal to "error". If we ever want to
        // differentiate (e.g. "Daemon offline" vs "Something broke")
        // add a new `chatsState` variant first.
        latestSeq = mySeq;
        setChatsState("error");
      }
    };

    // Initial fetch on mount + every pathname change.
    fetchChats();

    // Real-time path: subscribe to /chats/events SSE so chats fired
    // via MCP / external curl appear instantly. Refetch on any
    // change event (created/updated/deleted) — list is short, daemon
    // read is cheap, so we don't bother patching state incrementally.
    //
    // Fallback path: 2s poll when SSE is closed (initial connect
    // failure or tab hidden). 2s is the user-perceived "instant"
    // ceiling and safe even at scale because the list endpoint is a
    // single SQLite read of 12 rows.
    let evtSrc: EventSource | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    let sseConnected = false;

    const startPoll = () => {
      if (interval) return;
      interval = setInterval(fetchChats, 2000);
    };
    const stopPoll = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    const startSse = () => {
      if (evtSrc) return;
      try {
        evtSrc = new EventSource("/api/daemon/api/v1/chats/events");
        evtSrc.onopen = () => {
          sseConnected = true;
          stopPoll(); // SSE took over — drop the safety-net poll
        };
        evtSrc.onmessage = () => {
          // Any change event triggers a refetch; payload is metadata only.
          fetchChats();
        };
        evtSrc.onerror = () => {
          // EventSource auto-reconnects with backoff. While it's
          // disconnected we resume polling so the UI keeps updating.
          sseConnected = false;
          startPoll();
        };
      } catch {
        // EventSource unsupported / blocked — fall back to poll only.
        startPoll();
      }
    };

    const stopSse = () => {
      if (evtSrc) {
        evtSrc.close();
        evtSrc = null;
        sseConnected = false;
      }
    };

    const onVisibility = () => {
      if (document.hidden) {
        stopSse();
        stopPoll();
      } else {
        fetchChats();
        startSse();
        if (!sseConnected) startPoll(); // until SSE opens
      }
    };

    if (typeof document !== "undefined" && !document.hidden) {
      startSse();
      startPoll(); // safety net until SSE opens
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      cancelled = true;
      stopSse();
      stopPoll();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
    // Mount-once effect — DOES NOT depend on pathname. Active-route
    // highlighting reads `pathname` during render via `isActive(href)`,
    // not from this effect, so a navigation should re-render the nav
    // items WITHOUT tearing down the SSE subscription or refetching
    // the chat list. The old `[pathname]` dep paired with AppShell
    // remounting per-page meant every route click closed SSE, cleared
    // the poll, set chatsState back to "loading", and re-issued the
    // GET — visible as the "Loading…" flash that prompted this fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <div className="flex h-full flex-col">
      {/* Brand row — logo + name + version + collapse toggle. When collapsed,
          only the logo + toggle render so the row stays a single icon column. */}
      <div className="flex h-14 items-center gap-2 border-b border-border px-3">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
          <TriadLogo className="h-[18px] w-[18px]" />
        </div>
        {!collapsed && (
          <>
            <span className="text-sm font-semibold tracking-tight">Chorus</span>
            <span className="ml-auto rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {daemonVersion ? `v${daemonVersion.replace(/^v/, "").replace(/-dev\.\d+$/, "")}` : "—"}
            </span>
          </>
        )}
        {onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground",
              collapsed && "ml-auto",
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-3.5 w-3.5" />
            ) : (
              <PanelLeftClose className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>

      {/* Primary nav (global). Collapsed mode strips labels and tightens
          padding so each item is a square icon button. */}
      <nav className={cn("py-3", collapsed ? "px-1.5" : "px-2")}>
        <ul className="flex flex-col gap-0.5">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    "flex items-center rounded-md text-sm transition-colors",
                    collapsed ? "justify-center px-2 py-2" : "gap-2 px-2 py-1.5",
                    isActive(item.href)
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {!collapsed && <span>{item.label}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Recent chats — Search + New chat sit ABOVE the scrollable list and
          stay sticky as the list grows. New chats appear at the top of the
          list (server returns chats ordered by created_at DESC). Hidden
          entirely in collapsed mode. */}
      {collapsed ? (
        <div className="min-h-0 flex-1" />
      ) : (
      <div className="flex min-h-0 flex-1 flex-col border-t border-border">
        {/* Sticky header: New chat + Recent label.
            Search button removed for v0.7 — it had no onClick and no
            backing API; clicking it would suggest a feature that doesn't
            exist. Lands in v0.8 with a Cmd+K modal. */}
        <div className="flex shrink-0 flex-col gap-2 bg-card/40 px-3 py-3">
          <Link
            href="/new"
            onClick={onNavigate}
            aria-label="New chat"
            className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New chat</span>
          </Link>
          <div className="mt-1 px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Recent
          </div>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {chatsState === "loading" ? (
            <div className="px-2 py-4 text-xs text-muted-foreground">
              Loading…
            </div>
          ) : chatsState === "error" ? (
            <div className="px-2 py-4 text-xs text-muted-foreground">
              Can&apos;t reach Chorus. Try restarting it from your terminal:{" "}
              <code className="rounded bg-muted/40 px-1 font-mono text-[10px] text-foreground/80">
                chorus start
              </code>
            </div>
          ) : chats.length === 0 ? (
            <div className="px-2 py-4 text-xs text-muted-foreground">
              No chats yet.{" "}
              <Link
                href="/new"
                onClick={onNavigate}
                className="text-primary transition hover:underline"
              >
                Start one →
              </Link>
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {chats.map((c) => {
                const href = `/runs/${c.slug || c.id}`;
                const active = pathname === href;
                const display = chatDisplayTitle(c.work);
                const title = display.length > 60 ? `${display.slice(0, 60)}…` : display;
                return (
                  <li key={c.id}>
                    <Link
                      href={href}
                      onClick={onNavigate}
                      className={cn(
                        "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                        active
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          STATUS_DOT[c.status],
                        )}
                      />
                      {/* Single-line clamp keeps each item glanceable. The
                       * 2-line wrap mode let multi-paragraph artifact prompts
                       * dominate the sidebar at 4-6 lines per row.
                       * `min-w-0` lets `truncate` shrink under the flex parent. */}
                      <span className="min-w-0 flex-1 truncate leading-snug" title={display}>
                        {title}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>
      </div>
      )}

      {/* Update-available banner — pinned to the bottom of the sidebar.
          Only shown when daemon's /update-check returned updateAvailable=true.
          Hidden in collapsed mode (the up-arrow icon would lose its label
          and most users use collapsed mode for keyboard-first navigation
          where they wouldn't click a banner anyway). */}
      {!collapsed && updateInfo && (
        <div className="shrink-0 border-t border-border bg-primary/5 px-3 py-2.5">
          <div className="flex items-start gap-2">
            <ArrowUpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium text-foreground">
                Update available
              </div>
              <div className="font-mono text-[10px] text-muted-foreground">
                v{updateInfo.current.replace(/^v/, "")} → v{updateInfo.latest.replace(/^v/, "")}
              </div>
              <div className="mt-1 font-mono text-[10px] text-muted-foreground/80">
                Run <code className="rounded bg-muted/40 px-1 text-foreground/80">chorus update</code>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Desktop sidebar — hidden on mobile (md and up only).
 * Mobile users get the same content via MobileNav (Sheet overlay).
 *
 * Collapse state persists across reloads via localStorage. Width transitions
 * smoothly (200ms) for a Linear/Raycast feel.
 */
// Subscribe-to-storage adapter for `useSyncExternalStore`. The browser
// fires `storage` events on OTHER tabs only, so a same-tab toggle
// re-renders via the local tick bump in `toggle`; the listener handles
// cross-tab sync (open chorus in two tabs → toggle in one → both
// update).
const subscribeToStorage = (callback: () => void): (() => void) => {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
};
const getCollapsedSnapshot = (): boolean =>
  readCollapsed(typeof window === "undefined" ? null : window.localStorage);
// SSR snapshot: render expanded so the first paint matches the default
// for new users. Hydration may flip to collapsed after mount; the CSS
// width transition makes the swap feel intentional rather than jumpy.
const getServerCollapsedSnapshot = (): boolean => false;

export function AppSidebar() {
  // useSyncExternalStore subscribes to localStorage directly so we
  // don't need a useEffect+setState hydration step (which trips the
  // React Compiler `set-state-in-effect` rule). Same-tab toggles
  // bypass the storage event, so we bump a tick to force re-read.
  const [tick, bumpTick] = useState(0);
  const collapsed = useSyncExternalStore(
    subscribeToStorage,
    () => {
      void tick; // include the tick in the snapshot so same-tab writes re-read
      return getCollapsedSnapshot();
    },
    getServerCollapsedSnapshot,
  );

  const toggle = useCallback(() => {
    if (typeof window === "undefined") return;
    const next = !readCollapsed(window.localStorage);
    writeCollapsed(window.localStorage, next);
    // Bump the tick so the snapshot getter re-reads — `storage` events
    // don't fire same-tab.
    bumpTick((n) => n + 1);
  }, []);

  return (
    <aside
      className={cn(
        "hidden h-screen shrink-0 flex-col border-r border-border bg-card/30 transition-[width] duration-200 ease-out md:flex",
        collapsed ? "w-14" : "w-60",
      )}
    >
      <SidebarBody collapsed={collapsed} onToggleCollapsed={toggle} />
    </aside>
  );
}
