"use client";

import { Info, Layers } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, useTransition } from "react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { createChat, DaemonError, listTemplates } from "@/lib/api";
import { getBillingMode, type BillingMode } from "@/lib/api/settings";
import { isReviewOnlyTemplate, type Template } from "@/lib/types";
import {
  deriveReviewOnlyTitle,
  estimateCost,
  type Attachment,
} from "./helpers";
import { Picker } from "./picker";
import { PromptCard } from "./prompt-card";

export default function NewChatPage() {
  return (
    <Suspense
      fallback={
          <div className="p-8 text-sm text-muted-foreground">Loading…</div>
      }
    >
      <NewChatPageInner />
    </Suspense>
  );
}

function NewChatPageInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    listTemplates()
      .then(setTemplates)
      .catch((err) =>
        setLoadError(
          err instanceof DaemonError ? err.message : "Failed to load templates",
        ),
      );
  }, []);

  // Defaults to 'api' until the daemon answers, so users on subscriptions
  // see the conservative dollar estimate briefly on first paint, then
  // the truthful "subscription quota" badge once the request resolves.
  const [billingMode, setBillingMode] = useState<BillingMode>("api");
  useEffect(() => {
    getBillingMode()
      .then((b) => setBillingMode(b.mode))
      .catch(() => {
        /* leave default 'api' */
      });
  }, []);

  const templateId = params.get("template") ?? templates[0]?.id ?? "";
  const [prompt, setPrompt] = useState("");
  // Attachments are deferred to v0.8. Empty array kept so cost-estimate
  // math doesn't have to branch and the daemon-call shape stays the same.
  const attachments: Attachment[] = [];

  const template = templates.find((t) => t.id === templateId) ?? templates[0];

  const costEstimate = useMemo(
    () => estimateCost({ template, prompt, attachments }),
     
    [prompt, attachments, template],
  );

  // Cost-cap gate uses the worst-case (with retries) projection so a chat
  // doesn't sneak under the cap on the headline number then exceed it on
  // the first round of disagreement. Skipped entirely in subscription
  // mode where the user isn't paying per call.
  const overCap = Boolean(
    billingMode !== "subscription" &&
      template?.costCapUsd &&
      template.costCapUsd > 0 &&
      costEstimate.usdRangeMax > template.costCapUsd,
  );

  const [yoloMode, setYoloMode] = useState(false);
  const [repoPath, setRepoPath] = useState("");

  const reviewOnly = isReviewOnlyTemplate(template);
  const artifactSpec = reviewOnly ? template?.phases?.[0]?.artifact : undefined;

  async function handleStartRun() {
    if (!template || !prompt) return;

    // Pre-flight artifact size check so users hit a clear error before
    // the network round-trip. The daemon enforces this too — this is
    // just a nicer error path. Falls back to the schema default (1 MiB)
    // when the template doesn't declare its own cap.
    if (reviewOnly && artifactSpec) {
      const byteLen = new TextEncoder().encode(prompt).length;
      if (byteLen > artifactSpec.maxBytes) {
        setCreateError(
          `Artifact is ${byteLen.toLocaleString()} bytes; this template caps at ${artifactSpec.maxBytes.toLocaleString()}. Trim it down.`,
        );
        return;
      }
    }

    setCreateError(null);
    startTransition(async () => {
      try {
        const trimmedRepo = repoPath.trim();
        const chat = await createChat({
          // For review-only templates, `prompt` IS the artifact. work is
          // a static framing brief — reviewers see it but it doesn't
          // drive their critique. We derive a recognisable title from
          // the first non-empty, non-fenced line of the artifact so the
          // sidebar and run header reflect what the user actually
          // pasted, not the template's framing prompt.
          work: reviewOnly ? deriveReviewOnlyTitle(prompt) : prompt,
          templateId: template.id,
          files:
            attachments.length > 0 ? attachments.map((a) => a.name) : undefined,
          ...(reviewOnly ? { artifact: prompt } : {}),
          // Ship phase is meaningless for review-only — runner enforces
          // this too, but skip wiring repoPath so the cockpit doesn't
          // pretend it'll open a PR.
          ...(!reviewOnly && trimmedRepo.length > 0
            ? { repoPath: trimmedRepo }
            : {}),
          // Yolo only matters for chats with a ship phase; the daemon
          // ignores it on review-only runs. Sending unconditionally
          // keeps the call signature simple.
          yolo: yoloMode,
        });
        router.push(`/runs/${chat.slug || chat.id}`);
      } catch (err) {
        setCreateError(
          err instanceof DaemonError ? err.message : "Failed to create chat",
        );
      }
    });
  }

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

  if (!template) {
    return (
        <div className="mx-auto w-full max-w-6xl px-4 py-12 text-sm text-muted-foreground sm:px-6 md:px-8">
          Loading templates…
        </div>
    );
  }

  return (
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
        <PageHeader
          eyebrow="New chat"
          title={
            reviewOnly
              ? "Paste an artifact. Get reviews."
              : "Paste a task. Pick a template."
          }
          subtitle={
            reviewOnly
              ? "Chorus skips the doer and runs your text past three reviewers. Single pass — revise yourself and resubmit for another round."
              : "Chorus runs it past your reviewers and reports consensus."
          }
        />

        {createError && (
          <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">{createError}</p>
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Picker
            icon={<Layers className="h-3.5 w-3.5" />}
            label="Template"
            value={template?.name || "Select a template"}
            wide
          >
            <ul className="space-y-1">
              {templates.map((t) => {
                // Templates whose seed-time adapter couldn't fill every
                // slot are non-runnable until the user edits the YAML.
                // Don't let them be selected here — silent failure
                // would surface as a confusing "no model" error mid-run.
                const incomplete = t.isComplete === false;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      disabled={incomplete}
                      onClick={() => {
                        if (incomplete) return;
                        const newParams = new URLSearchParams(params);
                        newParams.set("template", t.id);
                        router.push(`/new?${newParams.toString()}`);
                      }}
                      className={`block w-full rounded-md p-2 text-left transition ${
                        incomplete
                          ? "cursor-not-allowed opacity-50"
                          : t.id === templateId
                            ? "bg-accent"
                            : "hover:bg-accent/50"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{t.name}</span>
                        {isReviewOnlyTemplate(t) && (
                          <Badge
                            variant="outline"
                            className="border-blue-500/30 bg-blue-500/10 font-mono text-[9px] uppercase text-blue-300"
                          >
                            review only
                          </Badge>
                        )}
                        {incomplete && (
                          <Badge
                            variant="outline"
                            className="border-amber-500/40 bg-amber-500/10 font-mono text-[9px] uppercase text-amber-300"
                          >
                            needs setup
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground line-clamp-1">
                        {incomplete
                          ? "Edit this template's YAML to fill in models for your fleet."
                          : t.description}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Picker>
        </div>

        <PromptCard
          template={template}
          prompt={prompt}
          setPrompt={setPrompt}
          reviewOnly={reviewOnly}
          artifactSpec={artifactSpec}
          billingMode={billingMode}
          costEstimate={costEstimate}
          overCap={overCap}
          isPending={isPending}
          onStart={handleStartRun}
        />

        {overCap && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-[11px] text-rose-200">
            <Info className="mt-0.5 h-3 w-3 shrink-0 text-rose-400" />
            <span>
              Estimated cost{" "}
              <span className="font-mono">${costEstimate.usd.toFixed(3)}</span>{" "}
              exceeds template cap{" "}
              <span className="font-mono">
                ${template.costCapUsd.toFixed(2)}
              </span>
              . Trim attachments, shorten the prompt, or raise the cap in
              template settings.
            </span>
          </div>
        )}

        {/* Always render so the row's vertical position is stable across
            templates. Disabled on review-only since there's no doer to make
            edits and no Ship phase to open a PR — but keeping it visible
            tells the user what they'd unlock by switching templates. */}
        <div
          className={`mb-4 rounded-lg border border-dashed border-border bg-card/30 p-4 ${reviewOnly ? "opacity-50" : ""}`}
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              Target repo{" "}
              <span className="text-muted-foreground">(optional)</span>
            </span>
            <Badge
              variant="outline"
              className="border-emerald-500/30 bg-emerald-500/10 font-mono text-[10px] uppercase text-emerald-300"
            >
              opens PR
            </Badge>
          </div>
          <input
            type="text"
            value={reviewOnly ? "" : repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            disabled={reviewOnly}
            placeholder="/absolute/path/to/repo"
            className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
            spellCheck={false}
          />
          <p className="mt-2 text-[11px] text-muted-foreground">
            {reviewOnly
              ? "Review-only templates have no doer and no Ship phase, so there's nothing to commit. Pick a template with a doer (e.g. Tri-Review) to open a PR."
              : (
                <>
                  When set: doer makes real edits in this repo. After reviewers
                  agree, chorus opens a PR via{" "}
                  <code className="rounded bg-muted px-1">gh pr create</code> (no
                  auto-merge — you review + click Merge in GitHub). Leave blank
                  to skip the Ship phase.
                </>
              )}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setYoloMode((v) => !v)}
          className={`mb-4 flex w-full items-start justify-between gap-3 rounded-lg border px-4 py-3 text-left transition ${
            yoloMode
              ? "border-rose-500/40 bg-rose-500/5"
              : "border-dashed border-border bg-card/30 hover:border-foreground/30"
          }`}
        >
          <div className="flex items-start gap-3">
            <span
              className={`mt-0.5 grid h-7 w-7 place-items-center rounded-md text-sm ${
                yoloMode
                  ? "bg-rose-500/20 text-rose-300"
                  : "bg-card text-muted-foreground"
              }`}
            >
              🚀
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">
                  Yolo mode
                </span>
                <Badge
                  variant="outline"
                  className="border-rose-500/30 bg-rose-500/10 font-mono text-[10px] uppercase text-rose-300"
                >
                  unsafe
                </Badge>
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {yoloMode
                  ? "Reviewer gates auto-approve. Permission prompts auto-allow. The driver merges without asking. Cost cap still enforced."
                  : "Skip every ask-user gate for this single run. Useful for trusted templates or trivial fixes."}
              </p>
            </div>
          </div>
          <span
            className={`flex h-5 w-9 shrink-0 items-center rounded-full border p-0.5 transition ${
              yoloMode
                ? "border-rose-500/40 bg-rose-500/20"
                : "border-border bg-card"
            }`}
          >
            <span
              className={`h-3.5 w-3.5 rounded-full transition-transform ${
                yoloMode ? "translate-x-4 bg-rose-400" : "bg-muted-foreground/50"
              }`}
            />
          </span>
        </button>
      </div>
  );
}
