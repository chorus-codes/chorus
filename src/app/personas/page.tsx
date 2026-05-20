"use client";

/**
 * Personas page — browse the worldview prompts that drive `invoke_persona`.
 * Built-in library lives in `prompts/personas/*.md` and is seeded into the
 * `personas` table on every daemon boot. User-cloned rows are never
 * overwritten. The cockpit fetches both via GET /personas; full system_prompt
 * is loaded on demand when a persona is selected (GET /personas/:id).
 */

import { useCallback, useEffect, useState } from "react";
import { Copy, Loader2, Pencil, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { CodeBlock } from "@/components/code-block";
import { PersonaDialog } from "@/components/persona-dialog";
import {
  listPersonas,
  getPersona,
  savePersona,
  deletePersona,
  DaemonError,
} from "@/lib/api";
import type { Persona } from "@/lib/api/personas";
import { nextDuplicateId } from "@/lib/persona-duplicate-id";
import { lineageDot, lineageLabel } from "@/lib/lineage-maps";

export default function PersonasPage() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [selectedFull, setSelectedFull] = useState<Persona | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  // Bumped after every save/delete so the right-pane effect refetches the
  // updated_at-stamped row even when the selected id didn't change.
  const [reloadTick, setReloadTick] = useState(0);
  // When set, the per-row PersonaDialog mounted for this id opens
  // automatically and the trigger is consumed. Used by the Duplicate
  // affordance so the user lands directly in the new copy's edit form
  // without an extra click.
  const [autoOpenId, setAutoOpenId] = useState<string | null>(null);
  // Per-row "duplicate in flight" so we can show a spinner on the right
  // icon while the POST resolves; without it a slow daemon makes the
  // duplicate icon feel dead and tempts a second click.
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  // Delete confirms inline rather than via a modal so the toolbar stays
  // light. First click = arms (id stored here), second click within the
  // arming window fires. Auto-disarms after 4s so a forgotten arm doesn't
  // delete on a much-later stray click.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refresh = useCallback(async (preserveId?: string) => {
    try {
      const rows = await listPersonas();
      const sorted = [...rows].sort((a, b) => {
        if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
        return a.label.localeCompare(b.label);
      });
      setPersonas(sorted);
      if (preserveId && sorted.find((p) => p.id === preserveId)) {
        setSelectedId(preserveId);
      } else if (sorted.length > 0) {
        // Fall through to the first row when the preserved id no longer
        // exists (e.g. just-deleted) — without this the right pane would
        // strand on a stale id and render the empty state forever.
        setSelectedId((cur) => (sorted.find((p) => p.id === cur) ? cur : sorted[0].id));
      } else {
        setSelectedId("");
      }
      setReloadTick((n) => n + 1);
    } catch (err) {
      setLoadError(err instanceof DaemonError ? err.message : "Failed to load personas");
    }
  }, []);

  // Mount-only data load. `refresh()` is async + uses setState
  // internally; React Compiler's set-state-in-effect rule flags this
  // because it can't track through the closure. The pattern is
  // intentional and equivalent to the canonical "fetch on mount"
  // recipe — switching to a Suspense-based loader is a v0.8 cockpit
  // refactor, not a v0.7 launch fix.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  async function handleDeleteRow(target: Persona) {
    if (deletingId || target.builtin) return;
    if (confirmingDeleteId !== target.id) {
      setConfirmingDeleteId(target.id);
      setDeleteError(null);
      // Auto-disarm to avoid a long-lived primed Delete eating a later
      // accidental click; bumped from 4s to 8s after a real-user test
      // showed the original window timed out before the user could
      // re-confirm a long row. Matches the dialog's window.
      setTimeout(() => {
        setConfirmingDeleteId((cur) => (cur === target.id ? null : cur));
      }, 8000);
      return;
    }
    setDeletingId(target.id);
    setDeleteError(null);
    try {
      await deletePersona(target.id);
      setConfirmingDeleteId(null);
      await refresh();
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

  async function handleDuplicate(source: Persona) {
    if (duplicatingId) return;
    setDuplicatingId(source.id);
    setDuplicateError(null);
    try {
      // Need the full persona including system_prompt. List rows are
      // typically full (the daemon's listPersonas returns all columns)
      // but be defensive and refetch if the body is missing.
      const full =
        source.system_prompt && source.system_prompt.length > 0
          ? source
          : await getPersona(source.id);
      const taken = new Set(personas.map((p) => p.id));
      const newId = nextDuplicateId({ sourceId: source.id, taken });
      const saved = await savePersona({
        id: newId,
        label: `${full.label} (copy)`,
        one_liner: full.one_liner,
        system_prompt: full.system_prompt ?? "",
        recommended_lineage: full.recommended_lineage ?? null,
        // Record provenance so future tooling can trace which built-in or
        // user persona this copy was derived from. Past chats that
        // reference the source id continue to resolve there unchanged.
        // Flatten to the root: duplicating an already-duplicated row
        // points at the original ancestor, not the intermediate copy, so
        // the lineage chart stays one hop deep.
        forked_from: full.forked_from ?? full.id,
      });
      // Open the duplicate in edit mode immediately so the user can rename
      // or tweak before walking away. autoOpenId is consumed by the
      // per-row dialog's `key` + defaultOpen wiring (cleared after mount).
      setAutoOpenId(saved.id);
      await refresh(saved.id);
    } catch (err) {
      setDuplicateError(
        err instanceof DaemonError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Duplicate failed (unknown error)",
      );
    } finally {
      setDuplicatingId(null);
    }
  }

  // Fetch the full persona (with system_prompt) when selection changes.
  // The two synchronous setStates inside this effect (clearing on empty
  // selection + flipping the loading flag) trip React Compiler's
  // set-state-in-effect rule. Migrating to Suspense + use(promise) is
  // a v0.8 cockpit refactor; the canonical async-fetch pattern is
  // intentional here.
  useEffect(() => {
    if (!selectedId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedFull(null);
      return;
    }
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingFull(true);
    getPersona(selectedId)
      .then((p) => {
        if (cancelled) return;
        setSelectedFull(p);
      })
      .catch(() => {
        if (cancelled) return;
        setSelectedFull(null);
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingFull(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, reloadTick]);

  if (loadError) {
    return (
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">Error loading personas</p>
            <p className="mt-1 text-xs text-muted-foreground">{loadError}</p>
          </div>
        </div>
    );
  }

  return (
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
        <PageHeader
          eyebrow="Personas"
          title="Reviewer worldviews"
          subtitle={
            <>
              Each persona is a set of instructions that teaches the same model
              to look for different things. Same Claude or Codex, different
              worldview, wildly different findings. Use any of them via the{" "}
              <code className="font-mono text-foreground/80">invoke_persona</code> MCP
              tool from inside Claude Code, Cursor, Codex, or any editor with
              chorus wired up.
            </>
          }
          action={<PersonaDialog onSaved={(id) => refresh(id)} />}
        />

        {duplicateError && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Duplicate failed: {duplicateError}
          </div>
        )}
        {deleteError && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Delete failed: {deleteError}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.2fr]">
          {/* Persona list */}
          <div className="flex min-w-0 flex-col gap-2">
            {personas.map((p) => {
              const isSelected = p.id === selectedId;
              return (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedId(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedId(p.id);
                    }
                  }}
                  className={`group relative cursor-pointer rounded-xl text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                    isSelected
                      ? "ring-2 ring-primary/60 ring-offset-2 ring-offset-background"
                      : ""
                  }`}
                >
                  <Card className="bg-card p-4 transition group-hover:border-muted-foreground/30">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold">{p.label}</span>
                          {p.builtin ? (
                            <Badge
                              variant="outline"
                              className="border-border text-[10px]"
                            >
                              built-in
                            </Badge>
                          ) : (
                            <Badge className="bg-primary/15 text-[10px] text-primary">
                              user
                            </Badge>
                          )}
                          {p.recommended_lineage && (
                            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${lineageDot(p.recommended_lineage)}`}
                              />
                              {lineageLabel(p.recommended_lineage)}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                          {p.one_liner}
                        </p>
                        <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                          id: {p.id}
                        </p>
                      </div>
                    </div>
                  </Card>
                  {/* Edit + Duplicate per-row affordances. Visible on hover
                      or while selected. stopPropagation prevents the card's
                      onClick from firing and snapping focus mid-edit. The
                      Edit pencil needs the *full* persona (with
                      system_prompt) so it's gated on the right-pane fetch
                      having completed for this id; opening the dialog before
                      selectedFull lands would prefill an empty body.
                      Duplicate doesn't need that gate — the handler refetches
                      the source if its body is missing. The PersonaDialog's
                      `key` ties to autoOpenId so the duplicate's
                      defaultOpen=true takes effect on a fresh mount. */}
                  <div
                    className={`absolute bottom-3 right-3 flex items-center gap-1.5 transition ${
                      isSelected
                        ? "opacity-100"
                        : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedId(p.id);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      aria-label={`Duplicate persona ${p.label}`}
                      title="Duplicate"
                      disabled={duplicatingId === p.id}
                      onClick={() => handleDuplicate(p)}
                      className="grid h-7 w-7 place-items-center rounded-md border border-border bg-card text-muted-foreground transition hover:border-muted-foreground/40 hover:bg-accent/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {duplicatingId === p.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                    {!p.builtin && (
                      <button
                        type="button"
                        aria-label={
                          confirmingDeleteId === p.id
                            ? `Confirm delete persona ${p.label}`
                            : `Delete persona ${p.label}`
                        }
                        title={
                          confirmingDeleteId === p.id
                            ? "Click again to confirm"
                            : "Delete"
                        }
                        disabled={deletingId === p.id}
                        onClick={() => handleDeleteRow(p)}
                        className={`grid h-7 w-7 place-items-center rounded-md border transition disabled:cursor-not-allowed disabled:opacity-50 ${
                          confirmingDeleteId === p.id
                            ? "border-destructive bg-destructive/15 text-destructive"
                            : "border-border bg-card text-muted-foreground hover:border-destructive/50 hover:text-destructive"
                        }`}
                      >
                        {deletingId === p.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                    {selectedFull && selectedFull.id === p.id ? (
                      <PersonaDialog
                        key={`${p.id}:${autoOpenId === p.id ? "auto" : "manual"}`}
                        editing={selectedFull}
                        defaultOpen={autoOpenId === p.id}
                        onSaved={(id) => {
                          if (autoOpenId === p.id) setAutoOpenId(null);
                          refresh(id);
                        }}
                        onDeleted={() => {
                          if (autoOpenId === p.id) setAutoOpenId(null);
                          refresh();
                        }}
                      />
                    ) : (
                      // Placeholder pencil for unselected rows. The real
                      // PersonaDialog only mounts once selectedFull lands
                      // for this id, so on hover we show a stand-in that
                      // selects the card and queues auto-open. Once the
                      // right-pane fetch resolves the dialog re-renders
                      // above with defaultOpen=true.
                      <button
                        type="button"
                        aria-label={`Edit persona ${p.label}`}
                        title="Edit"
                        onClick={() => {
                          setSelectedId(p.id);
                          setAutoOpenId(p.id);
                        }}
                        className="grid h-7 w-7 place-items-center rounded-md border border-border bg-card text-muted-foreground transition hover:border-muted-foreground/40 hover:bg-accent/60 hover:text-foreground"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {personas.length === 0 && (
              <Card className="bg-card p-4 text-center text-sm text-muted-foreground">
                No personas yet. Daemon may still be seeding — refresh in a
                second.
              </Card>
            )}
          </div>

          {/* System prompt preview */}
          {selectedFull ? (
            <CodeBlock
              filename={`${selectedFull.id}.md`}
              charCount={selectedFull.system_prompt?.length ?? 0}
              footer={
                <>
                  <span>
                    Invoke via{" "}
                    <code className="rounded bg-muted/40 px-1 font-mono text-[10px] text-foreground/80">
                      invoke_persona({`{ personaId: "${selectedFull.id}" }`})
                    </code>
                  </span>
                  {selectedFull.builtin && (
                    <span>
                      edit at{" "}
                      <code className="font-mono text-[10px]">
                        prompts/personas/{selectedFull.id}.md
                      </code>
                    </span>
                  )}
                </>
              }
            >
              {selectedFull.system_prompt ?? ""}
            </CodeBlock>
          ) : loadingFull ? (
            <Card className="bg-card p-4 text-center text-muted-foreground">
              <p className="text-sm">Loading persona…</p>
            </Card>
          ) : (
            <Card className="bg-card p-4 text-center text-muted-foreground">
              <p className="text-sm">Select a persona to view its prompt.</p>
            </Card>
          )}
        </div>
      </div>
  );
}
