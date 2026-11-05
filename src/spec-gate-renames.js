/** Real Git rename hints for approved requirements whose gate disappeared [B23,N39]. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from './windows-child-process.js';
import { cleanGitEnvironment } from './git.js';

/** Follow recorded renames in chronological order; never guess a replacement from similar names. */
export function renamedGatePath(root, file) {
  const result = spawnSync('git', ['log', '--reverse', '--format=', '--name-status', '-z', '--find-renames', '--diff-filter=R', 'HEAD'],
    { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) return null;
  const parts = result.stdout.split('\0');
  let current = file;
  for (let index = 0; index < parts.length;) {
    const status = parts[index++].trim();
    if (!/^R\d+$/u.test(status)) continue;
    const from = parts[index++];
    const to = parts[index++];
    if (from === current && to) current = to;
  }
  return current !== file && existsSync(join(root, current)) ? current : null;
}

/** Quote exact row text and a suggested gate as literal shell arguments. */
export function revisionGateCommand(row, gate, from, to) {
  /** Shell quoting preserves literal requirement text and paths in the suggested command. */
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  return `pullboard spec draft ${quote(row.text)} --revises ${quote(row.id)} --gate ${quote(gate)} --reason ${quote(`Gate renamed from ${from} to ${to}.`)}`;
}
