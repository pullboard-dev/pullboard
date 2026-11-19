/** Shared fixtures of the disk-use tests: a fixture .git/pullboard with each store populated [C7]. */
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from './child.js';

export const MB = 1024 * 1024;
export const NOW = Date.parse('2026-11-08T12:00:00.000Z');
export const DAYS = (n) => (NOW - n * 86_400_000) / 1000;

/** Write a file of a size and age. */
export function put(path, megabytes, ageDays) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(megabytes * MB, 1));
  utimesSync(path, DAYS(ageDays), DAYS(ageDays));
}

/** A fixture .git/pullboard with each store populated. */
export function fixture(t) {
  const dir = privateFixtureFiles('pullboard-disk-use-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  put(join(dir, 'board.sqlite'), 1, 0);
  put(join(dir, 'worktree-archives', 'arch-old-1111', 'tree.bin'), 6, 90);
  put(join(dir, 'test-actions', 'action-old-2222.log'), 3, 40);
  put(join(dir, 'test-actions', 'action-kept-3333.log'), 3, 40);
  put(join(dir, 'test-actions', 'action-new-4444.log'), 3, 1);
  put(join(dir, 'flake-evidence', 'flake-old-5555', 'a.log'), 2, 60);
  writeFileSync(join(dir, 'gate-receipts.jsonl'), JSON.stringify({ id: 1, log: 'action-kept-3333.log' }) + '\n');
  return dir;
}
