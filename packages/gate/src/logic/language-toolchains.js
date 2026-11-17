/** The runner toolchains each detected language needs, read from detectLanguages entries [C7]. */

/** The probe's toolchain name rule (packages/runners/src/io/probe.js), so every name here is one a runner can record. */
export const TOOLCHAIN_NAME = /^[a-z][a-z0-9+_-]{0,31}$/u;

/** Each language's toolchains; a function reads the detected command when the front tool varies (uv, poetry, bundle, rake, gradle, flutter). */
const ROWS = Object.freeze({
  bun: ['bun'],
  cmake: ['cmake', 'ctest'],
  csharp: ['dotnet'],
  dart: command => (/^\s*flutter\s/u.test(command) ? ['flutter'] : ['dart']),
  deno: ['deno'],
  elixir: ['mix'],
  go: ['go'],
  gradle: command => (/^\s*gradle\s/u.test(command) ? ['gradle', 'java'] : ['java']),
  make: ['make'],
  maven: ['java', 'mvn'],
  node: ['node'],
  php: command => (/^\s*composer\s/u.test(command) ? ['composer', 'php'] : ['php']),
  python: command => [...(/^\s*uv\s/u.test(command) ? ['uv'] : /^\s*poetry\s/u.test(command) ? ['poetry'] : []), 'python3'],
  ruby: command => (/^\s*bundle\s/u.test(command) ? ['bundle', 'ruby'] : /^\s*rake\s/u.test(command) ? ['rake', 'ruby'] : ['ruby']),
  rust: ['cargo'],
  swift: ['swift'],
});

/**
 * The sorted unique toolchains a runner needs to test these detected languages, plus the languages no row knows.
 * Why: runners record toolchains and admission reads runners.requiredToolchains, but nothing maps a repo to what it needs,
 * so a Python job could be offered to a runner with no python3 and fail red instead of waiting for one that has it.
 *
 * @param {{ language: string, command?: string }[]} entries detectLanguages output
 * @returns {{ toolchains: string[], unknown: string[] }}
 */
export function languageToolchains(entries) {
  const toolchains = new Set();
  const unknown = new Set();
  for (const entry of entries ?? []) {
    const language = entry?.language;
    if (typeof language !== 'string' || !Object.hasOwn(ROWS, language)) {
      unknown.add(String(language));
      continue;
    }
    const row = ROWS[language];
    for (const name of typeof row === 'function' ? row(String(entry.command ?? '')) : row) toolchains.add(name);
  }
  return { toolchains: [...toolchains].sort(), unknown: [...unknown].sort() };
}

/** Every language with a toolchain row, sorted. */
export const TOOLCHAIN_LANGUAGES = Object.freeze(Object.keys(ROWS).sort());
