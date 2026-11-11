/** A test rename may repoint its gate without changing any requirement bytes [L3,B34]. */
import { gitSpawnSync } from '../../../../git/index.js';
import { cleanGitEnvironment } from '../../../../git/index.js';
import {
  parseSpec,
  replaceRowGate,
} from '../main.js';
import { isDefaultTestFile } from '../../../../codemap/light.js';

/** Keep exact Git object bytes, including terminal whitespace that requirement edits must not hide. */
function rawGit(root, args) {
  return gitSpawnSync(['--no-replace-objects', ...args],
    { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/** Compare exact Git versions; the empty target revision means the actual staged index. */
export function specGateMoveOnly(root, file, before = 'HEAD', after = '') {
  if (!file) return false;
  const status = rawGit(root, ['diff', ...(after ? [] : ['--cached']), '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames', before, ...(after ? [after] : []), '--']);
  if (status.status !== 0) return false;
  const fields = status.stdout.split('\0');
  const moves = new Map();
  for (let index = 0; index < fields.length;) {
    const code = fields[index++];
    const from = fields[index++];
    if (!code?.startsWith('R')) continue;
    const to = fields[index++];
    if (from && to && isDefaultTestFile(from) && isDefaultTestFile(to)) moves.set(from, to);
  }
  if (!moves.size) return false;
  const original = rawGit(root, ['show', `${before}:${file}`]);
  const target = rawGit(root, ['show', `${after}:${file}`]);
  if (original.status !== 0 || target.status !== 0 || original.stdout === target.stdout) return false;
  const lines = original.stdout.split('\n');
  for (const row of parseSpec(original.stdout).rows) {
    if (!row.gate) continue;
    const gate = row.gate.split(/(\s+|,)/u).map(token => moves.get(token)
      ?? (token.startsWith('./') && moves.has(token.slice(2)) ? './' + moves.get(token.slice(2)) : token)).join('');
    if (gate !== row.gate) lines[row.line - 1] = replaceRowGate(lines[row.line - 1], gate);
  }
  return lines.join('\n') === target.stdout;
}
