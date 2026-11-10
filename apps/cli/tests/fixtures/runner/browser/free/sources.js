/** Generated browser-admission fixture source data [C7]. */
// Undeclared: no first-line browser marker, so it needs no browser even though it starts a Node child.
export const FREE = "import { test } from 'node:test';\nimport { spawnSync } from 'node:child_process';\n"
  + "test('browser-free file ran', () => { if (spawnSync(process.execPath, ['-e', '0']).status !== 0) throw new Error('child failed'); });\n";
// Declared: its first line is the browser marker, so it takes a browser lease.
export const CHROME = "// pullboard: browser\nimport { test } from 'node:test';\nimport { spawnSync } from 'node:child_process';\nconst chrome = 'google-chrome';\n"
  + "test('browser-bound file ran', () => { if (process.env.PULLBOARD_FIXTURE_NEVER_SET) spawnSync(chrome, ['--version']); });\n";
// Declared like CHROME, under its own name, for a run whose lease is refused for want of a browser slot.
export const DECLARED = "// pullboard: browser\nimport { test } from 'node:test';\n"
  + "test('declared file ran', () => { if (process.env.PULLBOARD_TEST_BROWSER_SLOT !== 'held') throw new Error('no browser lease'); });\n";
// A test body that prints and throws the refusal text: an ordinary red, never a lease refusal.
export const MARKER = "import { test } from 'node:test';\n"
  + "test('marker file ran', () => { console.log('[BROWSER_SLOT_REQUIRED] printed by a test'); throw new Error('[BROWSER_SLOT_REQUIRED] thrown by a test'); });\n";

