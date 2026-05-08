/**
 * File system watcher for phase output completion.
 * Ported from openbridge folder transport pattern.
 * Watches for answer.md completion via:
 *   - done sentinel file appearance (preferred)
 *   - answer.md ending with sentinel string (default: ## DONE)
 *   - 90s silence after first write (matches openbridge timeout)
 */

import fs from 'fs';
import path from 'path';

export interface WatcherResult {
  /** Full answer content. */
  content: string;
  /** true if sentinel was found; false if timeout/silence. */
  full: boolean;
}

/**
 * Wait for an answer file to be written and completed.
 * Resolves when:
 *   - done sentinel file appears (preferred), OR
 *   - answer.md ends with the configured sentinel string (default ## DONE), OR
 *   - 90s silence after first write (matches openbridge timeout)
 *
 * Rejects on timeoutMs reached.
 */
export async function waitForAnswer(
  answerFile: string,
  opts: { timeoutMs: number; doneSentinel?: string }
): Promise<WatcherResult> {
  const { default: chokidar } = await import('chokidar');
  const sentinel = opts.doneSentinel || '## DONE';
  const silenceTimeoutMs = 90_000;
  const answerDir = path.dirname(answerFile);
  const answerBasename = path.basename(answerFile);

  return new Promise((resolve, reject) => {
    let resolved = false;
    let lastWriteTime = 0;
    let firstWriteTime = 0;

    // Main timeout
    const mainTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        watcher.close();
        if (silenceCheckInterval) clearInterval(silenceCheckInterval);
        reject(new Error(`Timeout waiting for answer after ${opts.timeoutMs}ms`));
      }
    }, opts.timeoutMs);

    // Silence checker: if 90s pass without a write, assume complete
    const checkSilence = () => {
      if (!resolved && firstWriteTime > 0 && Date.now() - lastWriteTime > silenceTimeoutMs) {
        resolved = true;
        watcher.close();
        if (silenceCheckInterval) clearInterval(silenceCheckInterval);
        clearTimeout(mainTimeout);

        try {
          const content = fs.readFileSync(answerFile, 'utf-8');
          resolve({ content, full: content.includes(sentinel) });
        } catch (error) {
          reject(new Error(`Failed to read answer file: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    };
    const silenceCheckInterval = setInterval(checkSilence, 5000);

    // Watch the directory for changes
    const watcher = chokidar.watch(answerDir, {
      ignored: /node_modules/,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 },
      persistent: true,
    });

    // Shared handler — chokidar fires 'add' on first creation and 'change'
    // on subsequent writes. CLIs that write the whole answer in one shot
    // (Claude, Gemini) only trigger 'add'; CLIs that stream (Codex) trigger
    // 'change'. We need both.
    const onAnswerWrite = (filePath: string) => {
      if (path.basename(filePath) !== answerBasename) return;

      lastWriteTime = Date.now();
      if (firstWriteTime === 0) firstWriteTime = lastWriteTime;

      try {
        const content = fs.readFileSync(answerFile, 'utf-8');
        if (content.includes(sentinel)) {
          if (!resolved) {
            resolved = true;
            watcher.close();
            if (silenceCheckInterval) clearInterval(silenceCheckInterval);
            clearTimeout(mainTimeout);
            resolve({ content, full: true });
          }
        }
      } catch {
        // File not yet readable on this snapshot, retry on next write event.
      }
    };

    watcher.on('add', onAnswerWrite);
    watcher.on('change', onAnswerWrite);

    // Optional explicit `done` sentinel file — kept as an opt-in escape hatch
    // for shims that prefer marker-file completion over content sentinel.
    watcher.on('add', (filePath) => {
      if (path.basename(filePath) !== 'done') return;

      if (!resolved) {
        resolved = true;
        watcher.close();
        if (silenceCheckInterval) clearInterval(silenceCheckInterval);
        clearTimeout(mainTimeout);

        try {
          const content = fs.readFileSync(answerFile, 'utf-8');
          resolve({ content, full: true });
        } catch (error) {
          reject(new Error(`Failed to read answer file: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    });

    watcher.on('error', (error) => {
      if (!resolved) {
        resolved = true;
        watcher.close();
        if (silenceCheckInterval) clearInterval(silenceCheckInterval);
        clearTimeout(mainTimeout);
        reject(error);
      }
    });
  });
}
