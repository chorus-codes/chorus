#!/usr/bin/env node
// Chorus CLI entry. Resolves dist/ when published, falls back to tsx for dev.

// Hard-gate Node version BEFORE any imports — package.json sets engines.node
// >=20 but npm only WARNS on engine mismatch unless engine-strict is set
// (and almost no user has that). Without this gate a Node 18 user hits a
// stack of cryptic ESM/native errors instead of a one-line message.
const [nodeMajor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 20) {
  console.error(
    `\n  ✗ Chorus requires Node 20 or newer (you have ${process.versions.node}).\n  Install latest LTS from https://nodejs.org/ or via your version manager (nvm, fnm, asdf).\n`,
  );
  process.exit(1);
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

// Crash hook — installed BEFORE any other import so it captures early
// startup failures. The src/cli/crash-hook.ts version is the testable
// canonical source; this is its zero-dependency twin, kept inline so it
// works even if `await import(distEntry)` itself throws (e.g. the Node
// 25 + Windows ESM URL scheme bug that motivated this work).
//
// Field set must stay in sync with src/cli/crash-hook.ts buildCrashLog
// (timestamp, source, chorus, node, platform, argv, cwd, uptime_ms).
// Drift means the maintainer has to read two formats. The package
// version is read from package.json beside this file rather than
// importing pkg from src — that import would itself need to load via
// dist/src and could fail in the very situations this hook exists for.
const ISSUE_URL = "https://github.com/chorus-codes/chorus/issues/new";

function readChorusVersion() {
  try {
    const __dn = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(resolve(__dn, "..", "package.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed.version === "string" ? parsed.version : "(unknown)";
  } catch {
    return "(unknown)";
  }
}

function installCrashHook() {
  const crashDir = join(homedir(), ".chorus", "crashes");
  const version = readChorusVersion();
  const handle = (err, source) => {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const stack =
      err instanceof Error
        ? `${err.name}: ${err.message}\n${err.stack ?? "(no stack)"}`
        : String(err);
    const body = [
      "# Chorus crash report",
      "",
      `timestamp:    ${new Date().toISOString()}`,
      `source:       ${source}`,
      `chorus:       ${version}`,
      `node:         ${process.versions.node}`,
      `platform:     ${process.platform} ${process.arch}`,
      `argv:         ${process.argv.slice(1).join(" ")}`,
      `cwd:          ${process.cwd()}`,
      `uptime_ms:    ${Math.round(process.uptime() * 1000)}`,
      "",
      "## Error",
      "",
      stack,
      "",
    ].join("\n");
    let written = null;
    try {
      mkdirSync(crashDir, { recursive: true });
      written = join(crashDir, `${ts}.log`);
      writeFileSync(written, body, "utf-8");
    } catch {
      written = null;
    }
    const headline =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    process.stderr.write(`\n✗ Chorus crashed (${source}): ${headline}\n`);
    if (written) {
      process.stderr.write(`  Crash log saved to: ${written}\n`);
      process.stderr.write(`  Please attach it to a new issue: ${ISSUE_URL}\n`);
      process.stderr.write(`  Or run: chorus diagnose\n\n`);
    } else {
      process.stderr.write(`  (could not write log to ${crashDir})\n`);
      process.stderr.write(`  Please file an issue at ${ISSUE_URL} with:\n`);
      process.stderr.write(body + "\n\n");
    }
    process.exit(1);
  };
  process.on("uncaughtException", (err) => handle(err, "uncaughtException"));
  process.on("unhandledRejection", (err) => handle(err, "unhandledRejection"));
}
installCrashHook();

const __dirname = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(__dirname, "../dist/cli/index.js");

// Use pathToFileURL so dynamic import works on Windows where absolute
// paths look like `C:\...` and Node 25 rejects them as bare URLs with
// ERR_UNSUPPORTED_ESM_URL_SCHEME (Reddit user `SelectSouth2582` 2026-05-08).
if (existsSync(distEntry)) {
  await import(pathToFileURL(distEntry).href);
} else {
  // Dev / unpublished install — register tsx and run from src.
  const tsx = await import("tsx/esm/api");
  tsx.register();
  await import(pathToFileURL(resolve(__dirname, "../src/cli/index.ts")).href);
}
