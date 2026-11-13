/** The land job's static guard: the project's staticChecks on the merged tree, as the batch landing ran it [C7,#7492]. */
import { tryGit } from '../../../../git/index.js';

// The gate's static scope variable and whole-repo inputs (packages/gate STATIC_SCOPE_ENV, analysisScope), named here so
// the runner bundle stays free of the gate package, which reaches the CLI.
const STATIC_SCOPE_ENV = 'PULLBOARD_STATIC_SCOPE';
const WHOLE_REPO_INPUT = /^(?:pullboard\.json|package\.json|DOCTRINE\.md)$|\.json$/u;
// A scope list longer than this is not exported into a shell command line; the guard runs whole instead.
const SCOPE_PATH_LIMIT = 1000;

/** The `path:line: text` rows a static check prints, one per violation, as packages/landing static.js reads them. */
function staticRows(output) {
  return String(output ?? '').split('\n').map(line => /^(\S+?):(\d+): (.+)$/u.exec(line.trim())).filter(Boolean)
    .map(match => ({ file: match[1], line: Number(match[2]), text: match[3] }));
}

/**
 * The guard command handed the merged tree's changed paths, as submit scopes its static run; the whole command when a
 * path was deleted, is an input every rule reads, or the diff cannot be read.
 */
function scopedGuard(root, base, command) {
  const ran = tryGit(root, ['--no-replace-objects', 'diff', '--no-renames', '--name-status', base, 'HEAD']);
  if (ran.status !== 0) return command;
  const changes = ran.stdout.split('\n').filter(Boolean).map(row => { const [status, ...path] = row.split('\t'); return { status: status[0], path: path.join('\t') }; });
  if (changes.some(change => change.status === 'D' || WHOLE_REPO_INPUT.test(change.path)) || changes.length > SCOPE_PATH_LIMIT) return command;
  const files = changes.map(change => change.path).sort();
  return `export ${STATIC_SCOPE_ENV}='${JSON.stringify(files).replaceAll("'", "'\\''")}'; ${command}`;
}

/**
 * The static guard part of a land job's check: run the board's staticChecks command on the tree being checked, scoped
 * to the paths merged since the base as submit scopes it. A red names the guard and its failing rows, the rows in files
 * the merge changed first, so the returned item's builder reads which line to fix. Why: a pulled land job ran no static
 * guard, so an accepted item with a red guard landed as verified; the inline lander refused it LAND_STATIC_RED [C7].
 *
 * @param {unknown} command - The board config's staticChecks command, carried on the job.
 * @param {(argv: string[]) => (context: { root: string }) => Promise<{ ok: boolean, detail: string | null, output?: string }>} commandCheck - job.js's
 *   command runner, passed in so this module reaches nothing job.js loads.
 * @returns {((context: { root: string, base: string }) => Promise<{ ok: boolean, detail: string | null, guard?: string }>) | null} null when the job names no guard;
 *   guard: the config row that went red, so the board returns the item to its builder even under separate publish.
 */
export function staticGuardCheck(command, commandCheck) {
  const guard = typeof command === 'string' && command.trim() && !/\0/u.test(command) ? command.trim() : null;
  if (!guard) return null;
  return async ({ root, base }) => {
    const scoped = scopedGuard(root, base, guard);
    const result = await commandCheck(['sh', '-c', scoped])({ root });
    if (result.ok) return { ok: true, detail: null };
    const changed = new Set(tryGit(root, ['diff', '--no-renames', '--name-only', base, 'HEAD']).stdout.split('\n').filter(Boolean));
    const rows = staticRows(result.output);
    const own = rows.filter(row => changed.has(row.file));
    const named = (own.length ? own : rows).slice(0, 10).map(row => `${row.file}:${row.line}: ${row.text}`);
    const said = named.length ? named.join('; ') : String(result.output ?? result.detail ?? '').split('\n').filter(Boolean).slice(-8).join('\n');
    return { ok: false, guard: 'staticChecks', detail: `LAND_STATIC_RED: the static guard staticChecks (${guard.slice(0, 200)}) is red on the merged tree: ${said.slice(0, 600)}; fix those lines and resubmit` };
  };
}
