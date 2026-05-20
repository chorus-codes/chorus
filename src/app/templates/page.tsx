"use client";

import { useCallback, useState, useEffect } from "react";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { CodeBlock } from "@/components/code-block";
import { TemplateDialog } from "@/components/template-dialog";
import { listTemplates, deleteTemplate, DaemonError } from "@/lib/api";
import { Template } from "@/lib/types";
import { UI_LINEAGE_BRAND } from "@/lib/lineage-maps";

const LINEAGE_DOT: Record<string, string> = Object.fromEntries(
  Object.entries(UI_LINEAGE_BRAND).map(([k, v]) => [k, v.dot]),
);

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "review", label: "Review" },
  { id: "plan", label: "Plan" },
  { id: "debug", label: "Debug" },
  { id: "decide", label: "Decide" },
] as const;

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeCat, setActiveCat] =
    useState<(typeof CATEGORIES)[number]["id"]>("all");
  const [selectedId, setSelectedId] = useState<string>("");
  // Two-click delete confirm (matches /personas pattern). 8s auto-disarm
  // so a long-armed Delete doesn't eat a stray click later.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refreshTemplates = useCallback(
    async (preserveId?: string) => {
      try {
        const temps = await listTemplates();
        setTemplates(temps);
        if (preserveId && temps.find((t) => t.id === preserveId)) {
          setSelectedId(preserveId);
        } else if (temps.length > 0 && !selectedId) {
          setSelectedId(temps[0].id);
        }
      } catch (err) {
        setLoadError(
          err instanceof DaemonError ? err.message : "Failed to load templates",
        );
      }
    },
    [selectedId],
  );

  // Mount-only data load. `refreshTemplates()` is async + uses setState
  // internally; React Compiler's set-state-in-effect rule flags this
  // because it can't track through the closure. Canonical fetch-on-
  // mount pattern; Suspense migration deferred to v0.8.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
    refreshTemplates();
  }, []);

  async function handleDeleteRow(target: Template) {
    if (deletingId || target.source === "builtin") return;
    if (confirmingDeleteId !== target.id) {
      setConfirmingDeleteId(target.id);
      setDeleteError(null);
      // 8s auto-disarm matches the personas page.
      setTimeout(() => {
        setConfirmingDeleteId((cur) => (cur === target.id ? null : cur));
      }, 8000);
      return;
    }
    setDeletingId(target.id);
    setDeleteError(null);
    try {
      await deleteTemplate(target.id);
      setConfirmingDeleteId(null);
      // If the deleted template was selected, fall through to whichever row
      // refreshTemplates picks next (no preserveId).
      if (selectedId === target.id) setSelectedId("");
      await refreshTemplates();
    } catch (err) {
      setDeleteError(
        err instanceof DaemonError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Delete failed (unknown error)",
      );
      setConfirmingDeleteId(null);
    } finally {
      setDeletingId(null);
    }
  }

  const filtered =
    activeCat === "all"
      ? templates
      : templates.filter((t) => t.category === activeCat);

  const selected =
    templates.find((t) => t.id === selectedId) ?? templates[0] ?? null;

  if (loadError) {
    return (
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">Error loading templates</p>
            <p className="mt-1 text-xs text-muted-foreground">{loadError}</p>
          </div>
        </div>
    );
  }

  return (
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
        <PageHeader
          eyebrow="Templates"
          title="Reusable review workflows"
          subtitle="Each template defines the driver, reviewers, prompts, and quorum rule for a kind of task. Fork, edit, share."
          action={
            <TemplateDialog
              onSaved={(savedId) => refreshTemplates(savedId)}
            />
          }
        />

        {deleteError && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {deleteError}
          </div>
        )}

        <div className="mb-4 flex items-center gap-1 border-b border-border">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setActiveCat(c.id)}
              className={`relative px-3 py-2 text-sm transition ${
                c.id === activeCat
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {c.label}
              {c.id === activeCat && (
                <span className="absolute inset-x-3 bottom-0 h-0.5 bg-primary" />
              )}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1fr]">
          {/* Template list */}
          <div className="flex min-w-0 flex-col gap-2">
            {filtered.map((t) => (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId(t.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedId(t.id);
                  }
                }}
                className={`group relative cursor-pointer rounded-xl text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                  t.id === selectedId
                    ? "ring-2 ring-primary/60 ring-offset-2 ring-offset-background"
                    : ""
                }`}
              >
                <Card className="bg-card p-4 transition group-hover:border-muted-foreground/30">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold">
                          {t.name}
                        </span>
                        <Badge
                          variant="outline"
                          className="border-border text-[10px] capitalize"
                        >
                          {t.category}
                        </Badge>
                        {t.isComplete === false && (
                          <Badge
                            variant="outline"
                            className="border-amber-500/40 bg-amber-500/10 font-mono text-[9px] uppercase text-amber-300"
                          >
                            needs setup
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                        {t.isComplete === false
                          ? "Some slots couldn't be filled from your installed CLIs. Edit the YAML to pick models for each slot."
                          : t.description}
                      </p>
                    </div>
                  </div>
                  {t.phases[0]?.reviewer?.candidates.length ? (
                    <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
                      {/* review_only templates have no doer — start the row
                          with the reviewer dots directly. Standard phases
                          show "doer → reviewers". */}
                      {t.phases[0]?.kind !== "review_only" && (
                        <>
                          <span className="flex items-center gap-1">
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                            doer
                          </span>
                          <span className="text-muted-foreground/40">→</span>
                        </>
                      )}
                      <span className="flex items-center gap-1">
                        {t.phases[0]?.reviewer?.candidates.map((l) => (
                          <span
                            key={l}
                            className={`h-1.5 w-1.5 rounded-full ${LINEAGE_DOT[l]}`}
                            title={l}
                          />
                        ))}
                        <span>
                          {t.phases[0]?.reviewer?.candidates.length}{" "}
                          {t.phases[0]?.reviewer?.candidates.length === 1
                            ? "reviewer"
                            : "reviewers"}
                        </span>
                      </span>
                      {t.phases.length > 1 && (
                        <>
                          <span className="text-muted-foreground/40">·</span>
                          <span className="font-mono text-[10px]">
                            {t.phases.length} phases
                          </span>
                        </>
                      )}
                    </div>
                  ) : null}
                </Card>
                {/* Pencil edit affordance — appears on hover or when selected.
                    stopPropagation prevents the card's onClick from firing. */}
                <div
                  className={`absolute bottom-3 right-3 flex items-center gap-1.5 transition ${
                    t.id === selectedId
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedId(t.id);
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <TemplateDialog
                    editing={t}
                    onSaved={(savedId) => refreshTemplates(savedId)}
                    trigger={
                      <button
                        type="button"
                        aria-label={`Edit ${t.name}`}
                        className="grid h-7 w-7 place-items-center rounded-md border border-border bg-card text-muted-foreground transition hover:border-muted-foreground/40 hover:bg-accent/60 hover:text-foreground"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    }
                  />
                  {/* Delete — only for user-source templates (built-ins
                      refuse server-side because the boot seed re-creates
                      them; hiding the button here too avoids a confusing
                      400 on click). Two-click confirm + 8s auto-disarm,
                      matches the /personas pattern. */}
                  {t.source !== "builtin" && (
                    <button
                      type="button"
                      aria-label={
                        confirmingDeleteId === t.id
                          ? `Confirm delete ${t.name}`
                          : `Delete ${t.name}`
                      }
                      title={
                        confirmingDeleteId === t.id
                          ? "Click again to confirm"
                          : "Delete"
                      }
                      disabled={deletingId === t.id}
                      onClick={() => handleDeleteRow(t)}
                      className={`grid h-7 w-7 place-items-center rounded-md border transition disabled:cursor-not-allowed disabled:opacity-50 ${
                        confirmingDeleteId === t.id
                          ? "border-destructive bg-destructive/15 text-destructive"
                          : "border-border bg-card text-muted-foreground hover:border-destructive/50 hover:text-destructive"
                      }`}
                    >
                      {deletingId === t.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* YAML preview — sticky to top of viewport on lg+ so the
              pane fills the available height instead of capping at 60vh
              and leaving empty space when the list is short.
              Height reserves ~10rem total: ~6rem for the page header
              (eyebrow + title + subtitle + tabs) and ~4rem of bottom
              breathing room so the pane doesn't kiss the viewport edge. */}
          {selected ? (
            <div className="lg:sticky lg:top-6 lg:max-h-[calc(100vh-10rem)] lg:h-[calc(100vh-10rem)]">
              <CodeBlock
                filename={`${selected.id}.yaml`}
                charCount={selected.yaml.length}
                maxHeightClassName="h-full"
                footer={<span>by {selected.authorHandle}</span>}
              >
                {selected.yaml}
              </CodeBlock>
            </div>
          ) : (
            <Card className="bg-card p-4 text-center text-muted-foreground">
              <p>Select a template to view details</p>
            </Card>
          )}
        </div>
      </div>
  );
}
