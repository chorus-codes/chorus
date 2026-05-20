import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import {
  listOrchestrators,
  DaemonError,
  type OrchestratorStatus,
} from "@/lib/api";
import { OrchestratorCard } from "@/components/orchestrator-card";
import { OpenRouterCard } from "@/components/openrouter-card";
import { fetchFromDaemon } from "@/lib/api/client";
import type { Voice } from "@/lib/api/voices";
import type { ListEnvelope } from "@/lib/types";

const ORCHESTRATOR_TO_PROVIDER: Record<string, string> = {
  claude: "claude-code",
  codex: "codex-cli",
  gemini: "gemini-cli",
  opencode: "opencode-cli",
  kimi: "kimi-cli",
  grok: "grok-cli",
  antigravity: "antigravity-cli",
};

export const dynamic = "force-dynamic";

interface PageData {
  orchestrators: OrchestratorStatus[];
  cliVoices: Voice[];
  openrouterVoices: Voice[];
  error: string | null;
}

async function getPageData(): Promise<PageData> {
  try {
    const [orchestrators, cliEnv, orEnv] = await Promise.all([
      listOrchestrators().catch(() => []),
      // Default GET /voices returns ALL rows (enabled + disabled) — fleet
      // cards need both for the re-enable workflow.
      fetchFromDaemon<ListEnvelope<Voice>>("/voices?source=cli").catch(
        () => ({ items: [], total: 0, hasMore: false }),
      ),
      fetchFromDaemon<ListEnvelope<Voice>>(
        "/voices?source=api&provider=openrouter",
      ).catch(() => ({ items: [], total: 0, hasMore: false })),
    ]);
    return {
      orchestrators,
      cliVoices: cliEnv.items,
      openrouterVoices: orEnv.items,
      error: null,
    };
  } catch (err) {
    return {
      orchestrators: [],
      cliVoices: [],
      openrouterVoices: [],
      error:
        err instanceof DaemonError ? err.message : "Failed to reach the daemon",
    };
  }
}

export default async function ConnectPage() {
  const { orchestrators, cliVoices, openrouterVoices, error } =
    await getPageData();

  function voicesForOrchestrator(name: string): Voice[] {
    const provider = ORCHESTRATOR_TO_PROVIDER[name];
    if (!provider) return [];
    return cliVoices.filter((v) => v.provider === provider);
  }

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
        {error && (
          <div className="mb-6 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <PageHeader
          eyebrow="Connect"
          title="CLIs & voices"
          subtitle="Connect chorus to each editor (one-click MCP wiring) and pick which models from each CLI may run as voices. Toggles save automatically."
        />

        <section>
          {orchestrators.length === 0 ? (
            <div className="rounded-lg border border-border bg-card/30 p-6 text-sm text-muted-foreground">
              Daemon unreachable — orchestrator status will appear once it&apos;s up.
            </div>
          ) : (
            <div className="grid grid-cols-1 items-start gap-2 lg:grid-cols-2">
              {orchestrators
                .filter((o) => o.supported)
                .map((o) => (
                  <OrchestratorCard
                    key={o.name}
                    initial={o}
                    voices={voicesForOrchestrator(o.name)}
                  />
                ))}
              <OpenRouterCard voices={openrouterVoices} />
              {orchestrators
                .filter((o) => !o.supported)
                .map((o) => (
                  <OrchestratorCard
                    key={o.name}
                    initial={o}
                    voices={voicesForOrchestrator(o.name)}
                  />
                ))}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
