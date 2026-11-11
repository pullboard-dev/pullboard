/** Read shim ages from actual first-parent move history, never from a guessed file modification time [C7,CD64]. */
import { readPathMap } from '../../logic/path/map.js';
import { gitExecFileSync } from '../../../../git/index.js';
import { cleanGitEnvironment } from '../../../../git/index.js';
import { tryGit } from '../../../../git/index.js';
import { lex } from '../../../../kernel/index.js';

/** Read immutable objects in one Git batch; missing old paths are completed removals. */
function readObjects(root, paths) {
  if (!paths.length) return new Map();
  const bytes = gitExecFileSync(['cat-file', '--batch'], { cwd: root, env: cleanGitEnvironment(),
    input: paths.map(path => `${path}\n`).join(''), encoding: null, maxBuffer: 64 * 1024 * 1024 });
  const sources = new Map();
  let at = 0;
  for (const path of paths) {
    const end = bytes.indexOf(10, at);
    if (end < 0) throw new Error('incomplete shim history batch');
    const header = bytes.toString('utf8', at, end);
    at = end + 1;
    if (header.endsWith(' missing')) continue;
    const match = /^[a-f0-9]+ blob (\d+)$/u.exec(header);
    if (!match) throw new Error('invalid shim history batch');
    const length = Number(match[1]);
    if (at + length >= bytes.length || bytes[at + length] !== 10) throw new Error('truncated shim history batch');
    sources.set(path, bytes.toString('utf8', at, at + length));
    at += length + 1;
  }
  return sources;
}

/** Return each remaining shim with its Git-recorded landing date and native removal work item. */
export function shimLifecycle(root, { commit = 'HEAD', items = [] } = {}) {
  const metadata = tryGit(root, ['ls-tree', '--name-only', commit, '--', 'path-map.json', 'packages/codemap/data/plan/path-map']);
  if (metadata.status !== 0 || !metadata.stdout) return [];
  const map = readPathMap(root, { commit });
  if (!map.size) return [];
  const history = tryGit(root, ['log', '--first-parent', '--diff-merges=first-parent', '--no-renames', '--raw', '--no-abbrev',
    '--format=SHIM-DATE:%cI', commit, '--', 'path-map.json', 'packages/codemap/data/plan/path-map']);
  if (history.status !== 0) throw new Error('cannot read landed shim history');
  const edits = [], objects = new Set(), dates = new Map();
  let date = null;
  for (const line of history.stdout.split('\n')) {
    if (line.startsWith('SHIM-DATE:')) { date = line.slice('SHIM-DATE:'.length); continue; }
    const row = /^:[0-7]{6} [0-7]{6} ([a-f0-9]+) ([a-f0-9]+) [AMD]\t/u.exec(line);
    if (!row || !date) continue;
    const before = /^0+$/u.test(row[1]) ? null : row[1];
    const after = /^0+$/u.test(row[2]) ? null : row[2];
    for (const oid of [before, after]) if (oid) objects.add(oid);
    edits.push({ before, after, date });
  }
  const maps = readObjects(root, [...objects]);
  for (const edit of edits) {
    const before = edit.before ? JSON.parse(maps.get(edit.before)) : {};
    const after = edit.after ? JSON.parse(maps.get(edit.after)) : {};
    for (const path of Object.keys(after)) if (!Object.hasOwn(before, path) && !dates.has(path)) dates.set(path, edit.date);
  }
  const refs = [...map.keys()].map(path => `${commit}:${path}`);
  const sources = readObjects(root, refs);
  const result = [];
  for (const [path, target] of map) {
    const source = sources.get(`${commit}:${path}`);
    if (!source || !/^(?:export(?:\*|\{[^}]*\})from(?:''|"");?)+$/u.test(lex(source).code.replace(/\s/gu, ''))) continue;
    const cell = /^(?:packages|apps)\/([^/]+)\//u.exec(target)?.[1];
    if (!cell) continue;
    // Cell-wide cuts name the cell in their title even when the criterion omits individual paths.
    const cellName = new RegExp(`(?:^|[^a-z0-9_-])${cell.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:$|[^a-z0-9_-])`, 'iu');
    const matchesPath = item => `${item.item_title ?? ''}\n${item.item_criterion ?? ''}`.includes(path);
    const candidates = items.filter(item => /shim/iu.test(item.item_title ?? '')
      && /remov|delet|retir|\bcut\b|\bgo(?:es|ne)?\b/iu.test(item.item_title ?? '')
      && (matchesPath(item) || cellName.test(item.item_title ?? '')));
    candidates.sort((a, b) => Number(['verified', 'withdrawn'].includes(a.item_status)) - Number(['verified', 'withdrawn'].includes(b.item_status))
      || Number(matchesPath(b)) - Number(matchesPath(a)) || b.item_id - a.item_id);
    result.push({ path, cell, moveLandedAt: dates.get(path) ?? null,
      removalItem: candidates[0]?.item_id ?? null });
  }
  return result;
}
