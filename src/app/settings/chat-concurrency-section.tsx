"use client";

import { useEffect, useState } from "react";
import { Layers, Minus, Plus } from "lucide-react";
import {
  getChatConcurrencySettings,
  updateChatConcurrencySettings,
  type ChatConcurrencySettings,
} from "@/lib/api/settings";
import { Section } from "./primitives";

/**
 * Chat concurrency — daemon-wide cap on simultaneous chats + resource
 * guardrails.
 *
 * Distinct from the per-CLI Concurrency section above: this caps the
 * NUMBER OF CHATS that can fan out reviewers at once, plus refuses
 * admission when swap/load are under pressure. Added after the
 * 2026-05-20 incident — three Claude sessions each firing an 8-reviewer
 * chat overwhelmed the 31 GB host (load 320, swap exhausted).
 *
 * Save-on-blur (each input commits independently). Live snapshot shown
 * alongside the sliders so the user has actionable feedback.
 */
export function ChatConcurrencySection() {
  const [data, setData] = useState<ChatConcurrencySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      getChatConcurrencySettings()
        .then((res) => {
          if (cancelled) return;
          setData(res);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(
            err instanceof Error
              ? err.message
              : "Could not load chat concurrency settings.",
          );
        });
    };
    load();
    // Refresh the live block every 5s so "active chats / swap / load"
    // tracks reality while the user has the page open. Cheap — single
    // GET that includes the snapshot.
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const save = async (patch: {
    maxConcurrentChats?: number;
    swapMinFreeMb?: number;
    loadAvgMaxPerCore?: number;
  }): Promise<void> => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const next = await updateChatConcurrencySettings(patch);
      // Merge over the previous state — the PUT response carries
      // only the validated knob values, not `defaults` or `live`.
      // Without the prev merge, the UI's default-hint lines vanish
      // after the first save until the next polling GET. Self-review
      // (PR #64, codex-cli-0) caught it.
      setData((prev) => ({
        ...prev,
        ...next,
        defaults: next.defaults ?? prev?.defaults,
        live: prev?.live,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setPending(false);
    }
  };

  if (!data) {
    return (
      <Section
        id="chat-concurrency"
        icon={<Layers className="h-4 w-4" />}
        title="Chat concurrency"
        subtitle="Max chats fanning out at once + resource-pressure guardrails."
      >
        <div className="text-xs text-muted-foreground">{error ?? "Loading…"}</div>
      </Section>
    );
  }

  const live = data.live;
  const defaults = data.defaults;

  return (
    <Section
      id="chat-concurrency"
      icon={<Layers className="h-4 w-4" />}
      title="Chat concurrency"
      subtitle="Max chats fanning out simultaneously. Refuses admission when swap or load are under pressure. Distinct from the per-CLI cap above — this layer prevents the failure mode where N chats × M reviewers each oversubscribe the host."
    >
      {error && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {live && (
        <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border border-border bg-card/50 px-3 py-2 text-xs">
          <div className="text-muted-foreground">Active chats</div>
          <div className="font-mono text-foreground">
            {live.activeChats}
            {live.queueDepth > 0 && (
              <span className="text-amber-400"> + {live.queueDepth} queued</span>
            )}
          </div>
          <div className="text-muted-foreground">Free swap</div>
          <div className="font-mono text-foreground">
            {live.swapFreeMb > 0 ? `${live.swapFreeMb} MB` : <span className="text-muted-foreground">n/a</span>}
          </div>
          <div className="text-muted-foreground">Load avg (1m, per-core)</div>
          <div className="font-mono text-foreground">
            {(live.loadAvg1 / Math.max(1, live.cpuCount)).toFixed(2)}
            <span className="text-muted-foreground"> ({live.loadAvg1.toFixed(2)} / {live.cpuCount} cores)</span>
          </div>
        </div>
      )}

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <label htmlFor="cc-chats" className="block text-sm font-medium text-foreground">
              Max concurrent chats
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Hard cap on chats actively fanning out reviewers.
              {defaults && (
                <span className="text-muted-foreground/70"> Default {defaults.maxConcurrentChats}.</span>
              )}
            </p>
          </div>
          <NumberField
            id="cc-chats"
            min={1}
            max={20}
            value={data.maxConcurrentChats}
            disabled={pending}
            onCommit={(n) => save({ maxConcurrentChats: n })}
          />
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
          <div className="min-w-0">
            <label htmlFor="cc-swap" className="block text-sm font-medium text-foreground">
              Min free swap (MB)
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Refuse admission when free swap drops below this. 0 disables
              the check (boxes without swap / containers).
              {defaults && (
                <span className="text-muted-foreground/70"> Default {defaults.swapMinFreeMb}.</span>
              )}
            </p>
          </div>
          <NumberField
            id="cc-swap"
            min={0}
            max={16384}
            step={256}
            value={data.swapMinFreeMb}
            disabled={pending}
            onCommit={(n) => save({ swapMinFreeMb: n })}
          />
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
          <div className="min-w-0">
            <label htmlFor="cc-load" className="block text-sm font-medium text-foreground">
              Max load avg (per core)
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Refuse admission when 1-min load ÷ CPU count exceeds this.
              0 disables.
              {defaults && (
                <span className="text-muted-foreground/70"> Default {defaults.loadAvgMaxPerCore} on {defaults.cpuCount}-core host.</span>
              )}
            </p>
          </div>
          <NumberField
            id="cc-load"
            min={0}
            max={10}
            step={0.5}
            value={data.loadAvgMaxPerCore}
            disabled={pending}
            onCommit={(n) => save({ loadAvgMaxPerCore: n })}
          />
        </div>
      </div>
    </Section>
  );
}

interface NumberFieldProps {
  id: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  disabled?: boolean;
  onCommit: (n: number) => void;
}

/**
 * Stepper input shared with the per-CLI section. Local copy rather than
 * cross-section import to keep the section self-contained — the
 * per-CLI version has integer-only steps; this one accepts decimals
 * for load-per-core.
 */
function NumberField({ id, min, max, step = 1, value, disabled, onCommit }: NumberFieldProps) {
  const clamp = (n: number): number => Math.max(min, Math.min(max, n));
  const dec = (): void => {
    if (disabled) return;
    const next = clamp(Number((value - step).toFixed(2)));
    if (next !== value) onCommit(next);
  };
  const inc = (): void => {
    if (disabled) return;
    const next = clamp(Number((value + step).toFixed(2)));
    if (next !== value) onCommit(next);
  };

  return (
    <div className="flex items-center rounded-md border border-border bg-card">
      <button
        type="button"
        onClick={dec}
        disabled={disabled || value <= min}
        aria-label={`Decrease ${id}`}
        className="flex items-center justify-center px-2.5 py-1.5 text-muted-foreground transition hover:text-foreground disabled:opacity-30"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <input
        id={id}
        type="text"
        readOnly
        value={value}
        className="w-14 border-x border-border bg-transparent text-center font-mono text-sm tabular-nums focus:outline-none"
      />
      <button
        type="button"
        onClick={inc}
        disabled={disabled || value >= max}
        aria-label={`Increase ${id}`}
        className="flex items-center justify-center px-2.5 py-1.5 text-muted-foreground transition hover:text-foreground disabled:opacity-30"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
