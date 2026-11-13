/** The land job's static guard: the project's staticChecks on the merged tree, as the batch landing ran it [C7,#7492]. */
import { tryGit } from '../../../../git/index.js';
import { scopedStaticConfig } from '../static.js';
import { staticRows } from '../static.js';
import { commandCheck } from './job.js';

/**
 * The static guard part of a land job's check: run the board's staticChecks command on the tree being checked, scoped
 * to the paths merged since the base as submit scopes it. A red names the guard and its failing rows, the rows in files
 * the merge changed first, so the returned item's builder reads which line to fix. Why: a pulled land job ran no static
 * guard, so an accepted item with a red guard landed as verified; the inline lander refused it LAND_STATIC_RED [C7].
 *
 * @param {unknown} command - The board config's staticChecks command, carried on the job.
 * @returns {((context: { root: string, base: string }) => Promise<{ ok: boolean, detail: string | null, guard?: string }>) | null} null when the job names no guard;
 *   guard: the config row that went red, so the board returns the item to its builder even under separate publish.
 */
export function staticGuardCheck(command) {
  const guard = typeof command === 'string' && command.trim() && !/\0/u.test(command) ? command.trim() : null;
  if (!guard) return null;
  return async ({ root, base }) => {
    const scoped = scopedStaticConfig(root, base, { staticChecks: guard }).staticChecks;
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
