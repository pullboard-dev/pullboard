/** Real Git rename hints for approved requirements whose gate disappeared [B23,N39]. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { gitSpawnSync } from '../../../../git/index.js';
import { cleanGitEnvironment } from '../../../../git/index.js';

/** Follow recorded renames in chronological order; never guess a replacement from similar names. */
export function renamedGatePath(root, file) {
  const result = gitSpawnSync(['log', '--reverse', '--format=', '--name-status', '-z', '--find-renames', '--diff-filter=R', 'HEAD'],
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

/** Only an exact-content Git rename may defer its gate repoint to landing [B23,N39]. */
export function preservedGateRename(root, from, to) {
  const options = { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8' };
  const removed = gitSpawnSync(['log', '-1', '--format=%H', '--diff-filter=D', '--no-renames', 'HEAD', '--', from], options);
  const commit = removed.status === 0 ? removed.stdout.trim() : '';
  if (!/^[a-f0-9]{40}$/u.test(commit)) return false;
  const diff = gitSpawnSync(['diff', '--find-renames', '--name-status', '-z', `${commit}^`, 'HEAD'], options);
  if (diff.status !== 0) return false;
  const fields = diff.stdout.split('\0');
  let matched = false;
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++], oldPath = fields[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const newPath = fields[i++];
      if (status.startsWith('R') && oldPath === from && newPath === to) matched = true;
    }
  }
  if (!matched) return false;
  const before = gitSpawnSync(['rev-parse', `${commit}^:${from}`], options);
  const after = gitSpawnSync(['rev-parse', `HEAD:${to}`], options);
  return before.status === 0 && after.status === 0 && before.stdout.trim() === after.stdout.trim();
}
