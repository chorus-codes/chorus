"use client";

import { useMemo, useState } from "react";
import { Code2, Wrench } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { FormView } from "./form-view";
import {
  cyclePolicy as cyclePolicyValue,
  DEFAULT_DRIVER,
  DEFAULT_REVIEWER,
  type AutoApprove,
  type PrivacyTier,
  type Role,
} from "./primitives";
import { buildYaml, YamlEditor } from "./yaml-view";

export default function SettingsPage() {
  const [view, setView] = useState<"form" | "yaml">("form");

  const [maxConcurrent, setMaxConcurrent] = useState(3);
  const [driverPolicies, setDriverPolicies] =
    useState<Record<string, AutoApprove>>(DEFAULT_DRIVER);
  const [reviewerPolicies, setReviewerPolicies] =
    useState<Record<string, AutoApprove>>(DEFAULT_REVIEWER);
  const [allowedDirs, setAllowedDirs] = useState<string[]>([
    "~/dev",
    "~/work",
    "/tmp/chorus-sandbox",
  ]);
  const [newDir, setNewDir] = useState("");
  const [defaultDriver, setDefaultDriver] = useState("claude-code");
  const [defaultCostCap, setDefaultCostCap] = useState("2.00");
  const [defaultThreshold, setDefaultThreshold] = useState("unanimous");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [privacyTier, setPrivacyTier] = useState<PrivacyTier>("local");
  const [webhookTestState, setWebhookTestState] = useState<
    "idle" | "running" | "ok" | "fail"
  >("idle");

  function testWebhook() {
    if (webhookTestState === "running") return;
    setWebhookTestState("running");
    setTimeout(() => {
      setWebhookTestState(webhookUrl.startsWith("https://") ? "ok" : "fail");
      setTimeout(() => setWebhookTestState("idle"), 2200);
    }, 1100);
  }

  function cyclePolicy(role: Role, toolId: string) {
    if (role === "driver") {
      setDriverPolicies((prev) => ({
        ...prev,
        [toolId]: cyclePolicyValue(prev[toolId]),
      }));
    } else {
      setReviewerPolicies((prev) => ({
        ...prev,
        [toolId]: cyclePolicyValue(prev[toolId]),
      }));
    }
  }

  function addDir() {
    const d = newDir.trim();
    if (!d || allowedDirs.includes(d)) return;
    setAllowedDirs((prev) => [...prev, d]);
    setNewDir("");
  }

  const yaml = useMemo(
    () =>
      buildYaml({
        maxConcurrent,
        driverPolicies,
        reviewerPolicies,
        allowedDirs,
        defaultDriver,
        defaultCostCap,
        defaultThreshold,
        mcpEnabled,
        webhookUrl,
      }),
    [
      maxConcurrent,
      driverPolicies,
      reviewerPolicies,
      allowedDirs,
      defaultDriver,
      defaultCostCap,
      defaultThreshold,
      mcpEnabled,
      webhookUrl,
    ],
  );

  return (
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
        <PageHeader
          eyebrow="Settings"
          title="Workspace"
          subtitle="Defaults applied to every chat. Templates can override these per-run. The MCP server can read & patch this config — your main Claude can configure Chorus for you."
          action={
            <div className="flex rounded-md border border-border bg-card p-0.5">
              <button
                type="button"
                onClick={() => setView("form")}
                className={`flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-medium transition ${
                  view === "form"
                    ? "bg-primary/15 text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Wrench className="h-3.5 w-3.5" />
                Form
              </button>
              <button
                type="button"
                onClick={() => setView("yaml")}
                className={`flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-medium transition ${
                  view === "yaml"
                    ? "bg-primary/15 text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Code2 className="h-3.5 w-3.5" />
                YAML
              </button>
            </div>
          }
        />

        {view === "yaml" ? (
          <YamlEditor yaml={yaml} />
        ) : (
          <FormView
            maxConcurrent={maxConcurrent}
            setMaxConcurrent={setMaxConcurrent}
            driverPolicies={driverPolicies}
            reviewerPolicies={reviewerPolicies}
            cyclePolicy={cyclePolicy}
            allowedDirs={allowedDirs}
            setAllowedDirs={setAllowedDirs}
            newDir={newDir}
            setNewDir={setNewDir}
            addDir={addDir}
            defaultDriver={defaultDriver}
            setDefaultDriver={setDefaultDriver}
            defaultCostCap={defaultCostCap}
            setDefaultCostCap={setDefaultCostCap}
            defaultThreshold={defaultThreshold}
            setDefaultThreshold={setDefaultThreshold}
            webhookUrl={webhookUrl}
            setWebhookUrl={setWebhookUrl}
            mcpEnabled={mcpEnabled}
            setMcpEnabled={setMcpEnabled}
            privacyTier={privacyTier}
            setPrivacyTier={setPrivacyTier}
            webhookTestState={webhookTestState}
            testWebhook={testWebhook}
          />
        )}
      </div>
  );
}
