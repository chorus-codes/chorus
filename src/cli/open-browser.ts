/**
 * Lazy dynamic import of the `open` package.
 *
 * `open` v10+ is an ES Module; the CLI is currently compiled to CommonJS.
 * A top-level `import open from 'open'` would become `require('open')` in
 * the emitted JS, which throws ERR_REQUIRE_ESM at runtime. Using a dynamic
 * import() keeps us compatible with both CJS and ESM builds.
 */
export async function openBrowser(url: string): Promise<void> {
  const { default: open } = await import('open');
  await open(url);
}
