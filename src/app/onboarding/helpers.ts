export interface CliRow {
  id: string;
  provider: string;
  label: string;
  hint: string;
}

export interface ApiKeyRow {
  provider: string;
  label: string;
  placeholder: string;
}

export const CLIS: CliRow[] = [
  {
    id: "claude-code",
    provider: "anthropic",
    label: "Claude Code",
    hint: "Anthropic — uses your existing Claude login",
  },
  {
    id: "codex-cli",
    provider: "openai",
    label: "Codex CLI",
    hint: "OpenAI — ChatGPT Plus/Pro subscription",
  },
  {
    id: "gemini-cli",
    provider: "google",
    label: "Gemini CLI",
    hint: "Google — uses your gcloud auth",
  },
  {
    id: "opencode-cli",
    provider: "opencode",
    label: "OpenCode",
    hint: "OpenCode Go — routes Kimi, DeepSeek, Grok",
  },
  {
    id: "kimi-cli",
    provider: "moonshot",
    label: "Kimi CLI",
    hint: "MoonshotAI — kimi-k2 plan",
  },
  {
    id: "grok-cli",
    provider: "grok",
    label: "Grok Build",
    hint: "xAI — auto-picks chorus from ~/.claude.json (SuperGrok Heavy plan)",
  },
  {
    id: "cursor",
    provider: "cursor",
    label: "Cursor",
    hint: "Cursor IDE — invoke chorus from inside it",
  },
  {
    id: "windsurf",
    provider: "windsurf",
    label: "Windsurf",
    hint: "Windsurf IDE — invoke chorus from inside it",
  },
];

export const API_KEYS: ApiKeyRow[] = [
  { provider: "openrouter", label: "OpenRouter", placeholder: "sk-or-v1-..." },
];

/** Best-effort lineage classifier — mirrors the daemon's
 *  classifyOpencodeModel logic without importing it client-side. For
 *  uncovered models the lineage falls back to "opencode". */
export function classifyOpencodeClient(qualified: string): {
  lineage: "anthropic" | "openai" | "google" | "opencode" | "moonshot";
  vendor_family: string | null;
} {
  const slash = qualified.indexOf("/");
  const tail = (slash >= 0 ? qualified.slice(slash + 1) : qualified).toLowerCase();
  if (tail.includes("kimi")) return { lineage: "moonshot", vendor_family: null };
  if (tail.includes("claude")) return { lineage: "anthropic", vendor_family: null };
  if (tail.includes("gpt") || /(?:^|[^a-z])o[1-9](?:$|[^a-z0-9])/.test(tail))
    return { lineage: "openai", vendor_family: null };
  if (tail.includes("gemini")) return { lineage: "google", vendor_family: null };
  if (tail.includes("deepseek")) return { lineage: "opencode", vendor_family: "deepseek" };
  if (tail.includes("llama") || tail.includes("meta"))
    return { lineage: "opencode", vendor_family: "meta" };
  if (tail.includes("mistral") || tail.includes("mixtral"))
    return { lineage: "opencode", vendor_family: "mistral" };
  if (tail.includes("grok") || tail.includes("xai"))
    return { lineage: "opencode", vendor_family: "xai" };
  return { lineage: "opencode", vendor_family: null };
}

export function manualBinaryName(cliId: string): string {
  switch (cliId) {
    case "claude-code":
      return "claude";
    case "codex-cli":
      return "codex";
    case "gemini-cli":
      return "gemini";
    case "opencode-cli":
      return "opencode";
    case "kimi-cli":
      return "kimi";
    case "grok-cli":
      return "grok";
    default:
      return cliId;
  }
}
