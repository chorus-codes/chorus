// Settings and secrets API endpoints
import type { ListEnvelope, Settings, Secret } from "@/lib/types";
import { fetchFromDaemon } from "./client";

export type SandboxProfile = "strict" | "workspace" | "full";

export interface PermissionSettings {
  sandboxProfile: SandboxProfile;
  autoApprovePrompts: boolean;
  networkAccess: boolean;
  profileDescriptions?: Record<SandboxProfile, { label: string; description: string }>;
}

export async function getPermissions(): Promise<PermissionSettings> {
  return fetchFromDaemon<PermissionSettings>("/settings/permissions");
}

export type DetectableCliId =
  | "claude-code"
  | "codex-cli"
  | "gemini-cli"
  | "opencode-cli"
  | "kimi-cli";

export interface CliDetection {
  id: DetectableCliId;
  found: boolean;
  path?: string;
  source?: "path" | "fallback" | "manual";
  /** Populated on manual validation failures — surfaces "no file at
   *  that path", "binary doesn't look like the claude CLI", etc. so
   *  the UI can show a concrete reason inline. */
  reason?: string;
}

export async function detectInstalledClis(): Promise<CliDetection[]> {
  const env = await fetchFromDaemon<ListEnvelope<CliDetection>>("/onboard/detect-clis");
  return env.items;
}

export async function validateCliPath(
  id: DetectableCliId,
  path: string,
): Promise<CliDetection> {
  return fetchFromDaemon<CliDetection>("/onboard/validate-cli-path", {
    method: "POST",
    body: JSON.stringify({ id, path }),
  });
}

/**
 * Persist a manual CLI path for the daemon to use across restarts.
 * Backend re-validates server-side, so a stale React state can't store a
 * path that no longer runs. Returns the saved absolute path.
 */
export async function saveCliPath(
  id: DetectableCliId,
  path: string,
): Promise<{ id: string; path: string }> {
  return fetchFromDaemon<{ id: string; path: string }>(
    "/onboard/save-cli-path",
    {
      method: "POST",
      body: JSON.stringify({ id, path }),
    },
  );
}

export async function getSavedCliPaths(): Promise<Record<string, string>> {
  return fetchFromDaemon<Record<string, string>>("/onboard/cli-paths");
}

export async function clearSavedCliPath(
  id: DetectableCliId,
): Promise<{ id: string; cleared: boolean }> {
  return fetchFromDaemon<{ id: string; cleared: boolean }>(
    `/onboard/cli-paths/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export async function updatePermissions(
  patch: Partial<Omit<PermissionSettings, "profileDescriptions">>,
): Promise<PermissionSettings> {
  return fetchFromDaemon<PermissionSettings>("/settings/permissions", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function getSettings(): Promise<Settings> {
  return fetchFromDaemon<Settings>("/settings");
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return fetchFromDaemon<Settings>("/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export type Transport = "headless" | "tmux";

export interface TransportSettings {
  transport: Transport;
  descriptions?: Record<Transport, { label: string; description: string }>;
  /** False on Windows OR when the tmux binary isn't on PATH — cockpit
   *  greys out the Tmux card and shows an install hint instead of letting
   *  the user opt into a mode whose first chat would hang. */
  tmuxAvailable?: boolean;
}

export async function getTransport(): Promise<TransportSettings> {
  return fetchFromDaemon<TransportSettings>("/settings/transport");
}

export async function updateTransport(
  patch: { transport: Transport },
): Promise<TransportSettings> {
  return fetchFromDaemon<TransportSettings>("/settings/transport", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export interface ConcurrencySettings {
  maxParallelCli: number;
  perCli: Record<string, number>;
  cliLineages?: readonly string[];
  defaults?: {
    maxParallelCli: number;
    perCli: Record<string, number>;
  };
}

export async function getConcurrencySettings(): Promise<ConcurrencySettings> {
  return fetchFromDaemon<ConcurrencySettings>("/settings/concurrency");
}

export async function updateConcurrencySettings(
  patch: { maxParallelCli?: number; perCli?: Record<string, number> },
): Promise<ConcurrencySettings> {
  return fetchFromDaemon<ConcurrencySettings>("/settings/concurrency", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export interface ChatConcurrencySettings {
  maxConcurrentChats: number;
  swapMinFreeMb: number;
  loadAvgMaxPerCore: number;
  defaults?: {
    maxConcurrentChats: number;
    swapMinFreeMb: number;
    loadAvgMaxPerCore: number;
    cpuCount: number;
  };
  live?: {
    activeChats: number;
    queueDepth: number;
    swapFreeMb: number;
    loadAvg1: number;
    cpuCount: number;
  };
}

export async function getChatConcurrencySettings(): Promise<ChatConcurrencySettings> {
  return fetchFromDaemon<ChatConcurrencySettings>("/settings/chat-concurrency");
}

export async function updateChatConcurrencySettings(
  patch: {
    maxConcurrentChats?: number;
    swapMinFreeMb?: number;
    loadAvgMaxPerCore?: number;
  },
): Promise<ChatConcurrencySettings> {
  return fetchFromDaemon<ChatConcurrencySettings>("/settings/chat-concurrency", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export type BillingMode = "api" | "subscription" | "mixed";

export interface BillingSettings {
  mode: BillingMode;
  descriptions?: Record<BillingMode, { label: string; description: string }>;
}

export async function getBillingMode(): Promise<BillingSettings> {
  return fetchFromDaemon<BillingSettings>("/settings/billing");
}

export async function updateBillingMode(
  patch: { mode: BillingMode },
): Promise<BillingSettings> {
  return fetchFromDaemon<BillingSettings>("/settings/billing", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export interface TelemetryStatus {
  enabled: boolean;
  envOverride: boolean;
  fileOverride: boolean;
  settingValue: boolean | undefined;
  endpoint: string;
}

export async function getTelemetryStatus(): Promise<TelemetryStatus> {
  return fetchFromDaemon<TelemetryStatus>("/settings/telemetry");
}

export async function updateTelemetryEnabled(
  enabled: boolean,
): Promise<TelemetryStatus> {
  return fetchFromDaemon<TelemetryStatus>("/settings/telemetry", {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

export async function listSecrets(): Promise<Secret[]> {
  const env = await fetchFromDaemon<ListEnvelope<Secret>>("/secrets");
  return env.items;
}

export async function upsertSecret(
  provider: string,
  secret: Omit<Secret, "provider">,
): Promise<Secret> {
  return fetchFromDaemon<Secret>(`/secrets/${provider}`, {
    method: "PUT",
    body: JSON.stringify(secret),
  });
}

/**
 * Idempotent rotation. Returns `{ deleted }` indicating whether a row
 * was actually removed (`false` if it didn't exist). Cockpit can show
 * an info toast on `false` ("nothing to delete") if it cares.
 */
export async function deleteSecret(
  provider: string,
): Promise<{ provider: string; deleted: boolean }> {
  return fetchFromDaemon<{ provider: string; deleted: boolean }>(
    `/secrets/${encodeURIComponent(provider)}`,
    { method: "DELETE" },
  );
}
