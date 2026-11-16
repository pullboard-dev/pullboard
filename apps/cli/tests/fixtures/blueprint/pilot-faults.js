/**
 * The seeded faults of the in-process journey pilot (#8058): one small change to one production file each. A fault is
 * either a product fault (the same code runs in a real process and in-process) or a process-boundary fault (code only
 * a real process runs: the binary's exit code and stream wiring) [C7].
 */
export const FAULTS = Object.freeze([
  { id: 'url-guard-off', kind: 'product', file: 'packages/blueprints/src/io/main.js', find: '/^[A-Za-z][A-Za-z0-9+.-]*:\\/\\//u.test(text)', replace: '/^never:\\/\\//u.test(text)' },
  { id: 'missing-file-unrefused', kind: 'product', file: 'packages/blueprints/src/io/main.js', find: 'if (!bundled && !existsSync(file)) {', replace: 'if (false) {' },
  { id: 'repeat-add-refiles', kind: 'product', file: 'packages/blueprints/src/io/main.js', find: '  if (marked) {', replace: '  if (false) {' },
  { id: 'route-default-light', kind: 'product', file: 'packages/blueprints/src/io/main.js', find: "route: item.route ?? 'strong'", replace: "route: item.route ?? 'light'" },
  { id: 'already-line-reworded', kind: 'product', file: 'packages/blueprints/src/io/report.js', find: 'is already on this board; nothing added;', replace: 'is already on this board; nothing changed;' },
  { id: 'checks-not-run-reworded', kind: 'product', file: 'packages/blueprints/src/io/set.js', find: 'checks stored, not run:', replace: 'checks stored, run:' },
  { id: 'starter-check-unscoped', kind: 'product', file: 'packages/blueprints/src/io/main.js', find: "if (!BUNDLED.has(blueprint) || owns.length !== 1 || !owns[0].endsWith('/')) return command;", replace: 'return command;' },
  { id: 'refusal-code-renamed', kind: 'product', file: 'packages/blueprints/src/io/main.js', find: "new Refused('NO_BLUEPRINT'", replace: "new Refused('NO_SUCH_BLUEPRINT'" },
  { id: 'exit-code-dropped', kind: 'boundary', file: 'apps/cli/pullboard.js', find: 'process.exitCode = await main(process.argv.slice(2), {', replace: 'process.exitCode = 0 * await main(process.argv.slice(2), {' },
  { id: 'stdout-unwired', kind: 'boundary', file: 'apps/cli/pullboard.js', find: '    stdout: process.stdout,\n    stderr: process.stderr,', replace: '    stdout: { isTTY: false, write: () => true },\n    stderr: process.stderr,' },
  { id: 'stderr-unwired', kind: 'boundary', file: 'apps/cli/pullboard.js', find: '    stderr: process.stderr,\n    stdin: process.stdin,', replace: '    stderr: { write: () => true },\n    stdin: process.stdin,' },
]);
