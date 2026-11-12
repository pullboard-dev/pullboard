/** Source-bound Kernel contract consent reuses authenticated person decisions [C7]. */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { git } from '../../../git/index.js';
import { scanSource } from '../../../codemap/light.js';
import { Refused } from '../../../kernel/index.js';

const DOORS = ['packages/kernel/index.js', 'packages/kernel/light.js'];
const CHANGES = new Map();

/** Retain only immutable source analysis; live person decisions are deliberately never cached. */
function remember(key, result) {
  if (result) {
    for (const row of result.changes) { Object.freeze(row.names); Object.freeze(row); }
    Object.freeze(result.changes); Object.freeze(result);
  }
  if (key !== null) {
    CHANGES.set(key, result);
    if (CHANGES.size > 32) CHANGES.delete(CHANGES.keys().next().value);
  }
  return result;
}

/** Read regular committed modules only; missing files stay distinct from unreadable Git objects. */
function sourcesAt(root, commit) {
  const entries = git(root, ['ls-tree', '-r', '-z', commit, '--', 'packages/kernel']).split('\0').filter(Boolean);
  const files = new Map(entries.map(entry => {
    const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/u.exec(entry);
    if (!match || !/^100(?:644|755)$/u.test(match[1])) throw new Refused('KERNEL_EXPORT_SOURCE', 'restore regular committed Kernel source files before submitting');
    return [match[3], { blob: match[2], source: null }];
  }));
  return file => {
    const entry = files.get(file);
    if (!entry) return null;
    entry.source ??= git(root, ['show', `${commit}:${file}`]);
    return entry.source;
  };
}

/** Follow public re-exports without linking or evaluating candidate JavaScript. */
function exportedBindings(read, file, seen = new Set()) {
  if (seen.has(file)) return new Map();
  const source = read(file);
  if (source === null) return new Map();
  const module = scanSource(file, source);
  const result = new Map(module.exports.filter(name => name !== '*').map(name => [name, `${file}:${name}`]));
  const next = new Set([...seen, file]);
  for (const edge of module.reexports) {
    const target = posix.normalize(posix.join(posix.dirname(file), edge.from));
    const exported = exportedBindings(read, target, next);
    for (const name of edge.names) {
      if (name.exported === '*') {
        for (const [key, binding] of exported) if (key !== 'default') result.set(key, binding);
      } else result.set(name.exported, exported.get(name.imported) ?? `${target}:${name.imported}`);
    }
  }
  return result;
}

/** Bind approval to the exact before/after public contract, retaining moved or rebound names. */
export function kernelGateChange(root, base, commit) {
  const key = /^[a-f0-9]{40,64}$/u.test(base) && /^[a-f0-9]{40,64}$/u.test(commit) ? JSON.stringify([root, base, commit]) : null;
  if (key !== null && CHANGES.has(key)) return CHANGES.get(key);
  if (!git(root, ['diff', '--name-only', '-z', base, commit, '--', 'packages/kernel']).trim()) return remember(key, null);
  const before = sourcesAt(root, base), after = sourcesAt(root, commit);
  const changes = [];
  for (const file of DOORS) {
    const left = exportedBindings(before, file), right = exportedBindings(after, file);
    const names = [...new Set([...left.keys(), ...right.keys()])].sort()
      .filter(name => left.get(name) !== right.get(name));
    const changed = before(file) !== after(file);
    if (!changed && !names.length) continue;
    changes.push({ file, names: names.length ? names : [...new Set([...left.keys(), ...right.keys()])].sort(),
      before: before(file), after: after(file), previousBindings: [...left].sort(([a], [b]) => a.localeCompare(b)), bindings: [...right].sort(([a], [b]) => a.localeCompare(b)) });
  }
  if (!changes.length) return remember(key, null);
  const digest = createHash('sha256').update(JSON.stringify(changes)).digest('hex');
  return remember(key, { digest, changes: changes.map(({ file, names }) => ({ file, names })) });
}

/** The person's exact response is a contract-scoped approval, never a prose keyword search. */
export function kernelApprovalText(item, digest, approve = true) {
  return `${approve ? 'approve' : 'decline'} kernel exports #${item} ${digest}`;
}

/** Only a native person answer to a person decision authorizes this exact interface change. */
export function requireKernelApproval(board, { root, base, commit, item }) {
  const change = kernelGateChange(root, base, commit);
  if (!change) return;
  const approve = kernelApprovalText(item, change.digest);
  const decline = kernelApprovalText(item, change.digest, false);
  const latest = board.db.prepare(`SELECT answer.shout_text FROM shout answer JOIN shout ask ON ask.shout_id=answer.shout_answers
    WHERE answer.shout_from='person' AND ask.shout_to='person' AND ask.shout_decision=1
      AND answer.shout_text IN (?,?) ORDER BY answer.shout_id DESC LIMIT 1`).get(approve, decline);
  if (latest?.shout_text === approve) return;
  const names = change.changes.map(row => `${row.file}: ${row.names.join(', ') || '(front door removed or unsupported exports)'}`).join('; ');
  throw new Refused('KERNEL_EXPORT_APPROVAL', `Kernel front-door change needs the person’s approval; changed exports: ${names}`,
    `ask the coordinator to bring this exact change to the person, who answers a decision with: ${approve}`);
}
