/**
 * Persona file loader + DB seed.
 *
 * Built-in personas live as Markdown files with YAML frontmatter under
 * `prompts/personas/<id>.md`. The daemon reads them on startup and upserts
 * each into the `personas` table with `builtin = true`.
 *
 * Users can clone a built-in (creates a row with `builtin = false` and
 * `forked_from = <original-id>`), edit, and save. Re-seeding never overwrites
 * user rows — only built-in rows track the file.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import yaml from 'yaml';
import { personas, type PersonaRow } from './db/index.js';

interface PersonaFrontmatter {
  id: string;
  label: string;
  one_liner: string;
  recommended_lineage?: string;
  builtin?: boolean;
}

export interface ParsedPersonaFile {
  frontmatter: PersonaFrontmatter;
  body: string;
  source_path: string;
}

/**
 * Resolve the prompts/personas directory across dev (tsx, repo-relative)
 * and published (dist, package-relative) layouts.
 *
 * Dev: __dirname = <repo>/src/lib  → prompts dir = <repo>/prompts/personas
 * Built: __dirname = <repo>/dist/lib → prompts dir = <repo>/prompts/personas (still in repo)
 * Installed: __dirname = <pkg>/dist/lib → prompts dir = <pkg>/prompts/personas (shipped via "files")
 */
function resolvePromptsDir(): string {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'prompts', 'personas'),
    path.resolve(__dirname, '..', 'prompts', 'personas'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `prompts/personas not found. Looked in:\n  ${candidates.join('\n  ')}`,
  );
}

/**
 * Parse a single persona .md file with YAML frontmatter.
 * Frontmatter is delimited by `---` lines at the top of the file.
 */
function parsePersonaFile(filePath: string): ParsedPersonaFile {
  const raw = readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');

  if (!raw.startsWith('---\n')) {
    throw new Error(`${filePath}: missing YAML frontmatter (must start with "---")`);
  }

  const fmEnd = raw.indexOf('\n---\n', 4);
  if (fmEnd === -1) {
    throw new Error(`${filePath}: unclosed YAML frontmatter (missing closing "---")`);
  }

  const fmText = raw.slice(4, fmEnd);
  const body = raw.slice(fmEnd + 5).trim();

  const fm = yaml.parse(fmText) as PersonaFrontmatter;
  if (!fm?.id) throw new Error(`${filePath}: frontmatter missing required "id"`);
  if (!fm.label) throw new Error(`${filePath}: frontmatter missing required "label"`);
  if (!fm.one_liner) throw new Error(`${filePath}: frontmatter missing required "one_liner"`);
  if (!body) throw new Error(`${filePath}: empty body (the system prompt)`);

  return { frontmatter: fm, body, source_path: filePath };
}

/**
 * Read every *.md file under prompts/personas and return parsed entries.
 */
function loadPersonaFiles(): ParsedPersonaFile[] {
  const dir = resolvePromptsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  return files.map((f) => parsePersonaFile(path.join(dir, f)));
}

/**
 * Seed/refresh built-in personas in the DB from the prompt files.
 * - Built-in rows are upserted on every call (file = source of truth).
 * - User rows (builtin=0) are never touched.
 *
 * Returns the count of rows upserted.
 */
export async function seedBuiltinPersonas(): Promise<number> {
  const parsed = loadPersonaFiles();
  let count = 0;
  for (const { frontmatter, body } of parsed) {
    // Skip rows the user has edited via POST /personas (which sets
    // builtin=false). Without this guard, INSERT OR REPLACE in upsert()
    // would clobber the user's edits on every daemon boot. Same tradeoff
    // as templates: edited rows no longer auto-receive upstream changes.
    const existing = await personas.getById(frontmatter.id);
    if (existing && !existing.builtin) continue;
    await personas.upsert({
      id: frontmatter.id,
      label: frontmatter.label,
      one_liner: frontmatter.one_liner,
      system_prompt: body,
      recommended_lineage: frontmatter.recommended_lineage ?? null,
      builtin: true,
      forked_from: null,
    });
    count++;
  }
  return count;
}

/**
 * Public read API used by HTTP / MCP layers.
 */
export async function listPersonas(): Promise<PersonaRow[]> {
  return personas.list();
}

export async function getPersona(id: string): Promise<PersonaRow | null> {
  return personas.getById(id);
}
