"use client";

import { Clock, Shield } from "lucide-react";
import { BillingModeSection } from "./billing-section";
import { ChatConcurrencySection } from "./chat-concurrency-section";
import { ConcurrencySection } from "./concurrency-section";
import { PreviewSections, type PreviewSectionsProps } from "./preview-sections";
import { Section } from "./primitives";
import { TelemetrySection } from "./telemetry-section";
import { TransportSection } from "./transport-section";

export function FormView(props: PreviewSectionsProps) {
  return (
    <>
      <Section
        icon={<Shield className="h-4 w-4" />}
        title="Sandbox & first-call permissions"
        subtitle="What can chorus-spawned reviewers do on this machine? Pick a profile, toggle prompt auto-approval, choose whether to allow outbound network."
      >
        <a
          href="/settings/permissions"
          className="inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/10"
        >
          Open Permissions page
          <span aria-hidden>→</span>
        </a>
      </Section>

      <TransportSection />
      <ConcurrencySection />
      <ChatConcurrencySection />
      <BillingModeSection />
      <TelemetrySection />

      <div
        className="mt-12 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
        role="note"
      >
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <div>
          <p className="font-semibold">Coming in v0.8 — preview only</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-100/80">
            The sections below show planned controls. They&apos;re not wired
            to the daemon yet — interaction is disabled. The YAML toggle at
            the top of the page already exposes the schema if you&apos;re
            curious.
          </p>
        </div>
      </div>

      <PreviewSections {...props} />
    </>
  );
}
