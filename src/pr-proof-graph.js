/** One exact Git walk serves every ancestry and trailer question in a publication pass [B3,R3]. */
import { spawnSync } from './windows-child-process.js';
import { cleanGitEnvironment } from './git.js';

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Read only exact object names on stdin; missing objects cannot select refs or become proof. */
function batchGit(root, args, values) {
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.quotepath=false', ...args], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', input: values.join('\n') + '\n',
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 && !result.error ? result.stdout : null;
}

/** Preserve Git's trailer interpretation and the existing single, exact positive-item rule. */
function itemNumber(text) {
  const values = text.split('\n').filter(Boolean);
  const match = values.length === 1 && /^#([1-9][0-9]*)$/u.exec(values[0]);
  return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
}

/** Probe all endpoints together, then let Git parse parents and trailers in one shared history walk. */
export function readProofGraph(root, endpoints) {
  const seeds = [...new Set(endpoints.filter(value => COMMIT.test(value ?? '')))];
  const seedSet = new Set(seeds), nodes = new Map(), closures = new Map();
  const probe = seeds.length ? batchGit(root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], seeds) : '';
  const existing = (probe ?? '').split('\n').flatMap(line => {
    const [id, type] = line.split(' ');
    return type === 'commit' && seedSet.has(id) ? [id] : [];
  });
  const format = '%H%x00%P%x00%(trailers:key=Pullboard-Item,valueonly)%x00%(trailers:key=Pullboard-Companion,valueonly)%x00';
  const output = existing.length ? batchGit(root, ['log', '--no-decorate', '--topo-order', '--format=' + format, '--stdin'], existing) : '';
  const fields = (output ?? '').split('\0');
  if (fields.at(-1)?.trim() === '') fields.pop();
  let valid = probe !== null && output !== null && fields.length % 4 === 0;
  for (let index = 0; valid && index < fields.length; index += 4) {
    const id = fields[index].trim(), parents = fields[index + 1].split(' ').filter(Boolean);
    if (!COMMIT.test(id) || parents.some(parent => !COMMIT.test(parent)) || nodes.has(id)) { valid = false; break; }
    nodes.set(id, { parents, item: itemNumber(fields[index + 2]), companion: itemNumber(fields[index + 3]) });
  }
  if (!valid || existing.some(id => !nodes.has(id))) nodes.clear();
  /** Bound retained transitive sets; every result comes from this pass's immutable Git graph. */
  function ancestors(id) {
    if (closures.has(id)) return closures.get(id);
    const found = new Set(), pending = nodes.has(id) ? [id] : [];
    while (pending.length) {
      const next = pending.pop();
      if (found.has(next) || !nodes.has(next)) continue;
      found.add(next); pending.push(...nodes.get(next).parents);
    }
    closures.set(id, found);
    if (closures.size > 32) closures.delete(closures.keys().next().value);
    return found;
  }
  /** Discard redundant recorded ancestors without changing possible common-trunk witnesses. */
  function maximal(commits) {
    const selected = new Set(commits), older = new Set(), visited = new Set();
    const pending = commits.flatMap(id => nodes.get(id)?.parents ?? []);
    while (pending.length) {
      const id = pending.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      if (selected.has(id)) older.add(id);
      pending.push(...(nodes.get(id)?.parents ?? []));
    }
    return commits.filter(id => !older.has(id));
  }
  return { nodes, ancestors, maximal,
    isAncestor: (ancestor, descendant) => nodes.has(ancestor) && ancestors(descendant).has(ancestor),
    range: (base, head) => [...ancestors(head)].filter(id => !ancestors(base).has(id)) };
}
