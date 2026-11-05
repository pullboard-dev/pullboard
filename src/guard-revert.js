/**
 * A guard whose check passes when the guard is deleted is not a guard. An item can name its guard in
 * its criterion, and accept then reverts exactly that guard in a scratch tree and needs the frozen
 * check to fail there [C7,V4].
 *
 * Two forms: `guard: <path>:<from>-<to>` (lines of the submitted file, removed in the scratch tree) and
 * `guard: patch <path>` (a patch file in the submitted commit, applied in reverse).
 */
import { spawnSync } from './windows-child-process.js';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Refused } from './refused.js';
import { checkAtCommit } from './trusted-policy.js';

const GUARD = /\bguard:\s+(?:patch\s+(\S+)|(\S+?):(\d+)-(\d+))/u;

/**
 * Read the guard an item's criterion names, or null when it names none.
 *
 * @param {{ item_criterion?: string|null }} item
 * @returns {{ text: string, patch?: string, path?: string, from?: number, to?: number } | null}
 */
export function guardOf(item) {
  const found = GUARD.exec(item?.item_criterion ?? '');
  if (!found) return null;
  if (found[1]) {
    const patch = found[1].replace(/[.,;]+$/u, '');
    return { text: `patch ${patch}`, patch };
  }
  return { text: `${found[2]}:${found[3]}-${found[4]}`, path: found[2], from: Number(found[3]), to: Number(found[4]) };
}

/**
 * Revert one guard inside a scratch checkout.
 *
 * @param {string} directory
 * @param {NonNullable<ReturnType<typeof guardOf>>} guard
 * @returns {string} empty when reverted, else why it could not be
 */
function revert(directory, guard) {
  if (guard.patch) {
    if (!existsSync(join(directory, guard.patch))) return `${guard.patch} is not in the submitted commit`;
    const applied = spawnSync('git', ['apply', '-R', '--whitespace=nowarn', guard.patch], { cwd: directory, encoding: 'utf8' });
    return applied.status === 0 ? '' : `${guard.patch} does not reverse cleanly: ${String(applied.stderr).trim().split('\n')[0]}`;
  }
  const file = join(directory, guard.path);
  if (guard.path.startsWith('/') || guard.path.split('/').includes('..') || !existsSync(file)) return `${guard.path} is not in the submitted commit`;
  const lines = readFileSync(file, 'utf8').split('\n');
  if (guard.from < 1 || guard.to < guard.from || guard.to > lines.length) return `${guard.path} has no lines ${guard.from}-${guard.to}`;
  lines.splice(guard.from - 1, guard.to - guard.from + 1);
  writeFileSync(file, lines.join('\n'));
  return '';
}

/**
 * Run the frozen check with the item's named guard reverted, in a scratch tree at the submitted commit.
 * The caller's own run of the check at the commit is the restored run, so a green there plus a red here
 * proves the guard can fail. An item that names no guard returns an empty note.
 *
 * @param {string} root
 * @param {any} item - with item_commit and the frozen check
 * @param {object} [lease] - the held gate slot, shared with the restored run
 * @returns {string} the line the verdict note carries, or '' when no guard is named
 */
export function guardRevertNote(root, item, lease) {
  const guard = guardOf(item);
  if (!guard) return '';
  let problem = '';
  const run = checkAtCommit(root, item, { gateLease: lease, guard, mutate: (directory) => { problem = revert(directory, guard); return problem; } });
  problem ||= run.guardProblem ?? '';
  if (problem) throw new Refused('GUARD_NOT_FOUND', `#${item.item_id}'s guard ${guard.text} cannot be reverted: ${problem}`);
  if (run.state === 'pass') {
    throw new Refused('GUARD_CANNOT_FAIL', `#${item.item_id}'s check stays green with its guard ${guard.text} reverted, so the check does not test the guard`);
  }
  if (run.state !== 'red') throw new Refused('CHECK_UNVERIFIED', `the frozen check could not be verified with guard ${guard.text} reverted (${run.stage}); retry verification`);
  return `\nguard ${guard.text} reverted: check red; restored: check green`;
}
