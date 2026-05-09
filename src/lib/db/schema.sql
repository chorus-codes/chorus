CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  work TEXT NOT NULL,
  template_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_phase_idx INTEGER DEFAULT 0,
  yolo BOOLEAN DEFAULT 0,
  attached_files TEXT,
  -- Optional absolute path to the user's repo for the Ship phase. When set,
  -- doer cwd is this path (real edits land in the user's working tree).
  -- When unset, ship phase auto-skips and chat ends `approved`.
  repo_path TEXT,
  -- PR URL written by the Ship phase on success (status=merged).
  pr_url TEXT,
  -- Failure context written when ship fails (status=blocked).
  ship_error TEXT,
  -- Artifact text supplied at chat creation for review-only templates.
  -- NULL for full-pipeline templates (the doer produces the artifact).
  -- Capped at the template's phase.artifact.maxBytes (default 1 MiB) by
  -- the chat-create endpoint; SQLite TEXT itself has no useful limit.
  artifact TEXT,
  -- Final reviewer verdict from chat_done. NULL until terminal. Carries the
  -- actual consensus ('approved' / 'request_changes' / 'failed' /
  -- 'no_review' / 'cancelled') independently of `status` — `status='approved'`
  -- means "the chat ran cleanly", while `verdict` is what the reviewers
  -- said. Cockpit + CLI list views colour by verdict; status is the
  -- system-level outcome.
  verdict TEXT,
  -- Frozen template JSON captured the first time the runner fires for this
  -- chat. Subsequent edits to the live template row never touch this column,
  -- so old runs render with the candidate set + models that actually ran.
  -- NULL for chats created before this column existed, or for chats that
  -- never reached the runner — readers fall back to the live template by id.
  template_snapshot TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS phase_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  phase_idx INTEGER NOT NULL,
  phase_kind TEXT NOT NULL,
  role TEXT NOT NULL,
  agent_id TEXT,
  state TEXT NOT NULL,
  output TEXT,
  cost_usd REAL DEFAULT 0,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  FOREIGN KEY (chat_id) REFERENCES chats(id)
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  yaml TEXT NOT NULL,
  -- 0 = some slot couldn't be filled with the user's voices and was
  -- left blank; cockpit gates "Use template" until the user edits.
  -- 1 = every slot has at least one model assigned (canonical state).
  -- v0.8.3+: builtin templates may flip 0→1 as the user enables more
  -- CLIs; the seed loop re-adapts on every daemon boot.
  is_complete INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  provider TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  meta TEXT,
  updated_at INTEGER NOT NULL
);

-- Personas: a worldview/role a reviewer wears (system prompt + metadata).
-- Built-ins are seeded from prompts/personas/*.md on daemon startup.
-- Users can clone a built-in, edit, and save as their own (builtin=0).
CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  one_liner TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  recommended_lineage TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  forked_from TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Voices: a routable model surface unifying CLI subscriptions and
-- API-routed providers (added in v0.7).
--
-- A voice = (id, label, source, provider, model_id, lineage, vendor_family,
-- input_cost_per_mtok, output_cost_per_mtok, enabled).
--
-- ID conventions:
--   - Single-model CLIs:  id = '<provider>'  (immutable, e.g. 'claude-code'.
--                         model_id + label rewrite on each seed; the row
--                         never rotates to a versioned ID.)
--   - Multi-model CLIs:   id = '<provider>:<gateway-prefixed-model>'
--                         (e.g. 'opencode-cli:opencode-go/kimi-k2.6'.)
--   - API providers:      id = '<provider>:<canonical-model-id>'
--                         (e.g. 'openrouter:moonshotai/kimi-k2'.)
--
-- lineage stays in the existing daemon-side 5-enum
-- (anthropic|openai|google|opencode|moonshot — see
-- src/daemon/agents/types.ts). vendor_family carries the finer taxonomy
-- (deepseek|meta|mistral|xai|...) where the lineage is too coarse,
-- without widening the daemon Lineage type.
CREATE TABLE IF NOT EXISTS voices (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  lineage TEXT NOT NULL,
  vendor_family TEXT,
  input_cost_per_mtok REAL,
  output_cost_per_mtok REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Why a row is disabled. NULL = never disabled; 'user' = explicit cockpit
  -- toggle; 'auto_missing' = seed couldn't detect the CLI on a boot. Only
  -- 'auto_missing' rows get auto-re-enabled when the CLI returns; 'user'
  -- intent is sticky. Pre-fix DBs surface as NULL → treated as 'user' so
  -- we never silently override prior toggles after upgrade.
  disabled_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chats_status ON chats(status);
CREATE INDEX IF NOT EXISTS idx_phase_events_chat ON phase_events(chat_id, phase_idx);
CREATE INDEX IF NOT EXISTS idx_voices_lineage ON voices(lineage);
CREATE INDEX IF NOT EXISTS idx_voices_provider ON voices(provider);
CREATE INDEX IF NOT EXISTS idx_voices_source ON voices(source);
-- Speeds up `WHERE enabled = 0` scans used by `chorus diagnose` voice
-- health summary. Tiny table today (<200 rows) so the index is mostly
-- forward-looking, but cheap.
CREATE INDEX IF NOT EXISTS idx_voices_enabled ON voices(enabled);
