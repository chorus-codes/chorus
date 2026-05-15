/**
 * Compact "fleet status" panel for the home page.
 *
 * Shows each connected CLI plus its current health (recorded by the runner
 * when error-detector fires). Tells the user at a glance:
 *   - which CLIs are wired up
 *   - which ones are quota-exhausted (and when they reset)
 *   - which ones are auth-broken
 *
 * Server component. Fetches both /orchestrators (connection state) and
 * /cli/health (recent failure state) and merges them.
 */

import {
  CheckCircle2,
  AlertTriangle,
  Clock,
  CircleHelp,
  Plug,
} from "lucide-react";
import { fetchFromDaemon } from "@/lib/api/client";
import type { ListEnvelope } from "@/lib/types";
import { lineageDot } from "@/lib/lineage-maps";
import type { Voice } from "@/lib/api/voices";
import Link from "next/link";
import { OpencodeFleetCard } from "./opencode-fleet-card";
import { LineageFleetCard } from "./lineage-fleet-card";
import { OpenRouterFleetCard } from "./openrouter-fleet-card";

interface OrchestratorStatus {
  name: string;
  label: string;
  connected: boolean;
  supported: boolean;
}

interface CliHealth {
  lineage: string;
  status: "healthy" | "quota_exhausted" | "auth_invalid" | "rate_limited" | "unknown";
  message?: string;
  resetAt?: number;
  updatedAt: number;
}

// Map orchestrator name → underlying lineage tag for health lookup.
const ORCHESTRATOR_TO_LINEAGE: Record<string, string> = {
  claude: "anthropic",
  codex: "openai",
  gemini: "google",
  opencode: "opencode",
  kimi: "moonshot",
  grok: "grok",
};

// Map orchestrator name → voices.provider value for the fleet-card lookup.
// Single-model CLIs use immutable IDs equal to their provider (e.g.
// 'claude-code'). The fleet card filters voices by provider to render its
// per-model toggle list.
const ORCHESTRATOR_TO_PROVIDER: Record<string, string> = {
  claude: "claude-code",
  codex: "codex-cli",
  gemini: "gemini-cli",
  kimi: "kimi-cli",
  opencode: "opencode-cli",
  grok: "grok-cli",
};

function formatResetIn(resetAt?: number): string | null {
  if (!resetAt) return null;
  const ms = resetAt - Date.now();
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

function statusBadge(health: CliHealth): React.ReactNode {
  switch (health.status) {
    case "quota_exhausted":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300">
          <Clock className="h-3 w-3" />
          Quota exhausted
          {health.resetAt && (
            <span className="ml-1 text-amber-200/70">
              {formatResetIn(health.resetAt)}
            </span>
          )}
        </span>
      );
    case "auth_invalid":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
          <AlertTriangle className="h-3 w-3" />
          Auth broken
        </span>
      );
    case "rate_limited":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300">
          <Clock className="h-3 w-3" />
          Rate-limited
        </span>
      );
    case "healthy":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
          <CheckCircle2 className="h-3 w-3" />
          Healthy
        </span>
      );
    case "unknown":
    default:
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          <CircleHelp className="h-3 w-3" />
          Untested
        </span>
      );
  }
}

export async function CliStatusPanel() {
  let orchestrators: OrchestratorStatus[] = [];
  let healths: CliHealth[] = [];
  let allVoices: Voice[] = [];
  let openrouterVoices: Voice[] = [];
  try {
    const env = await fetchFromDaemon<ListEnvelope<OrchestratorStatus>>(
      "/orchestrators",
    );
    orchestrators = env.items;
  } catch {
    return null;
  }
  try {
    const env = await fetchFromDaemon<ListEnvelope<CliHealth>>("/cli/health");
    healths = env.items;
  } catch {
    healths = [];
  }
  try {
    // Default GET /voices returns ALL rows (enabled + disabled) — fleet
    // cards need both so users can re-enable from the toggle UI.
    const env = await fetchFromDaemon<ListEnvelope<Voice>>("/voices?source=cli");
    allVoices = env.items;
  } catch {
    /* voices load is best-effort */
  }
  try {
    const env = await fetchFromDaemon<ListEnvelope<Voice>>(
      "/voices?source=api&provider=openrouter",
    );
    openrouterVoices = env.items;
  } catch {
    /* best-effort */
  }

  function voicesForProvider(provider: string): Voice[] {
    return allVoices.filter((v) => v.provider === provider);
  }

  const healthByLineage: Record<string, CliHealth> = {};
  for (const h of healths) healthByLineage[h.lineage] = h;

  const connectedOrchestrators = orchestrators.filter((o) => o.connected);

  // Render the panel if there's any reviewer-eligible voice source —
  // a connected CLI orchestrator OR at least one OpenRouter voice.
  if (connectedOrchestrators.length === 0 && openrouterVoices.length === 0)
    return null;

  return (
    <section className="mt-10">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Reviewer fleet
        </h2>
        <Link
          href="/connect"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
        >
          <Plug className="h-3 w-3" />
          Manage connections →
        </Link>
      </div>
      <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {connectedOrchestrators.map((o) => {
          const lineage = ORCHESTRATOR_TO_LINEAGE[o.name] ?? o.name;
          const health = healthByLineage[lineage] ?? {
            lineage,
            status: "unknown" as const,
            updatedAt: 0,
          };
          // OpenCode is special — gateway-grouped and discovered via
          // `opencode models`. Other CLIs use the generic flat-list card
          // backed by UI_LINEAGE_AVAILABLE_MODELS. Cursor/Windsurf and
          // anything without a curated list fall through to the static
          // info card.
          const provider = ORCHESTRATOR_TO_PROVIDER[o.name];
          if (o.name === "opencode") {
            return (
              <OpencodeFleetCard
                key={o.name}
                health={{ status: health.status, message: health.message }}
                voices={voicesForProvider("opencode-cli")}
              />
            );
          }
          if (provider) {
            const providerVoices = voicesForProvider(provider);
            if (providerVoices.length > 0) {
              return (
                <LineageFleetCard
                  key={o.name}
                  lineage={lineage}
                  label={o.label}
                  voices={providerVoices}
                  health={{ status: health.status, message: health.message }}
                />
              );
            }
          }
          return (
            <div
              key={o.name}
              className="flex items-center gap-3 rounded-lg border border-border bg-card p-3"
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${lineageDot(lineage)}`}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{o.label}</div>
                <div className="mt-0.5">{statusBadge(health)}</div>
                {health.message && health.status !== "healthy" && health.status !== "unknown" && (
                  <div className="mt-1 truncate text-[10px] text-muted-foreground">
                    {health.message}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {openrouterVoices.length > 0 && (
          <OpenRouterFleetCard
            voices={openrouterVoices}
            health={
              healthByLineage["openrouter"]
                ? {
                    status: healthByLineage["openrouter"].status,
                    message: healthByLineage["openrouter"].message,
                  }
                : undefined
            }
          />
        )}
      </div>
    </section>
  );
}
