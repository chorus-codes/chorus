import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus, Sparkles, Users } from "lucide-react";
import { CliStatusPanel } from "@/components/cli-status-panel";
import { HomeStatsCards } from "@/components/home-stats-cards";
import { PageHeader } from "@/components/page-header";

export const dynamic = "force-dynamic";

import {
  listTemplates,
  listSecrets,
  getSettings,
  getStats,
  DaemonError,
} from "@/lib/api";
import type { StatsSummary } from "@/lib/api/stats";
import type { Template, Secret, Settings as SettingsType } from "@/lib/types";

interface HomeData {
  stats: StatsSummary | null;
  templates: Template[];
  secrets: Secret[];
  settings: SettingsType | null;
  error: string | null;
}

async function getHomePageData(): Promise<HomeData> {
  try {
    const [stats, templates, secrets, settings] = await Promise.all([
      getStats().catch(() => null),
      listTemplates(),
      listSecrets(),
      getSettings().catch(() => null),
    ]);
    return { stats, templates, secrets, settings, error: null };
  } catch (err) {
    const error =
      err instanceof DaemonError
        ? err.message
        : "Failed to reach the Chorus daemon.";
    return { stats: null, templates: [], secrets: [], settings: null, error };
  }
}

export default async function HomePage() {
  const { stats, templates, secrets, settings, error } = await getHomePageData();

  // First-run gate: redirect to /onboarding if user has no credentials
  // and hasn't explicitly marked the wizard as completed.
  const onboarded =
    Boolean(settings?.onboarded) || secrets.length > 0;
  if (!error && !onboarded) {
    redirect("/onboarding");
  }

  const hasRuns = (stats?.totalRuns ?? 0) > 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
        {error && (
          <div className="mb-8 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm font-medium text-destructive">
              Daemon unreachable
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {error} Start it with <code>chorus start</code>.
            </p>
          </div>
        )}

        {!hasRuns || !stats ? <EmptyHero /> : <ActiveHome stats={stats} />}

        <CliStatusPanel />

        {templates.length > 0 && (
          <section className="mt-12">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Start from a template
              </h2>
              <Link
                href="/templates"
                className="text-xs text-muted-foreground transition hover:text-foreground"
              >
                Browse all →
              </Link>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {templates.slice(0, 6).map((t) => (
                <Link
                  key={t.id}
                  href={`/new?template=${t.id}`}
                  className="group rounded-lg border border-border bg-card p-4 transition hover:border-muted-foreground/30"
                >
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-3.5 w-3.5 text-primary" />
                    <span className="text-sm font-medium">{t.name}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {t.description}
                  </p>
                </Link>
              ))}
            </div>
          </section>
        )}
    </div>
  );
}

function EmptyHero() {
  return (
    <section className="rounded-xl border border-border bg-gradient-to-br from-primary/10 via-card to-card p-6 sm:p-10">
      <div className="grid h-12 w-12 place-items-center rounded-lg bg-primary/15 text-primary">
        <Users className="h-6 w-6" />
      </div>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight">
        Many voices, one chorus.
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Paste a task, pick a template, and watch 2–4 LLMs of different lineages
        peer-review the work before you ship.
      </p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <Link
          href="/new"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          Start your first run
        </Link>
        <Link
          href="/templates"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border bg-card px-4 text-sm font-medium transition hover:border-muted-foreground/30"
        >
          Browse templates
        </Link>
      </div>
    </section>
  );
}

interface ActiveHomeProps {
  stats: StatsSummary;
}

function ActiveHome({ stats }: ActiveHomeProps) {
  return (
    <>
      <PageHeader
        eyebrow="Home"
        title="Overview"
        action={
          <Link
            href="/new"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            New chat
          </Link>
        }
      />

      <section>
        <HomeStatsCards stats={stats} />
      </section>
    </>
  );
}

