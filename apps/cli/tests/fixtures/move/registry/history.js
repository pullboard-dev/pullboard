/** Frozen registry source records are append-only; live registry checks never compare against them [C7,V4]. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HISTORICAL_DUPLICATE_ENGINES } from './invariants.js';

const HISTORY = 'packages/state/data/history';

/** Compare each record with its first committed bytes and require a record for each post-migration allocation. */
export function historyProblems(root, leaves, git) {
  const problems = [];
  // First-parent history: a record is frozen when it reaches the mainline, so a merge that regenerates a derived identity
  // list in a record two parallel allocations touched is not a change of the frozen bytes [C7,V4].
  const first = new Map();
  let commit;
  for (const line of git('log', '--first-parent', '--reverse', '--diff-merges=first-parent', '--format=H:%H', '--name-only', '--diff-filter=A', '--', HISTORY).split('\n')) {
    if (line.startsWith('H:')) commit = line.slice(2);
    else if (line.startsWith(`${HISTORY}/`) && !first.has(line)) first.set(line, commit);
  }
  for (const [file, added] of first) {
    if (!existsSync(join(root, file)) || readFileSync(join(root, file), 'utf8') !== git('show', `${added}:${file}`)) {
      problems.push(`frozen engine record changed: ${file}`);
    }
  }
  const legacy = JSON.parse(readFileSync(join(root, HISTORY, 'legacy.json'), 'utf8'));
  if (legacy.version !== 1 || !Number.isSafeInteger(legacy.throughEngine) || legacy.throughEngine < 1 || legacy.throughEngine !== Math.max(...legacy.engines.map(entry => entry.number))) problems.push('invalid legacy engine boundary');
  problems.push(...engineIdentityProblems(legacy, leaves, legacy.throughEngine));
  const replay = readFileSync(join(root, legacy.legacyReplay.path));
  if (createHash('sha256').update(replay).digest('hex') !== legacy.legacyReplay.sha256) problems.push('frozen legacy replay changed');
  const expected = new Map(leaves.filter(leaf => leaf.number > legacy.throughEngine).map(leaf => [leaf.number, leaf]));
  for (const file of readdirSync(join(root, HISTORY)).filter(file => file !== 'legacy.json')) {
    const record = JSON.parse(readFileSync(join(root, HISTORY, file), 'utf8'));
    const leaf = expected.get(record.engine);
    if (!leaf || file !== `${record.engine}.json` || record.version !== 1 || record.name !== leaf.name
        || !record.declarations || !Object.keys(record.declarations).length) problems.push(`invalid engine record ${file}`);
    problems.push(...engineIdentityProblems(record, leaves, record.engine));
    if (!Array.isArray(record.engines) || !record.engines.some(entry => entry?.name === record.name && entry.number === record.engine)) problems.push(`missing allocated engine identity ${file}`);
    expected.delete(record.engine);
  }
  for (const number of expected.keys()) problems.push(`missing frozen engine record ${number}`);
  return problems;
}

/** Check frozen engine identities against their live leaves without freezing today's move declarations. */
function engineIdentityProblems(record, leaves, boundary) {
  if (!Array.isArray(record.engines) || !record.engines.length) return ['invalid frozen engine identities'];
  const problems = [];
  const names = new Set();
  const numbers = new Set();
  const files = new Set();
  for (const entry of record.engines) {
    if (!entry || typeof entry.file !== 'string' || typeof entry.name !== 'string'
        || !Number.isSafeInteger(entry.number) || entry.number < 1 || entry.number > boundary
        || names.has(entry.name) || numbers.has(entry.number) && !sharesNamedNumber(entry, record.engines) || files.has(entry.file)) {
      problems.push('invalid frozen engine identities');
      continue;
    }
    names.add(entry.name); numbers.add(entry.number); files.add(entry.file);
    const live = leaves.find(leaf => leaf.file === entry.file);
    if (!live || live.name !== entry.name || live.number !== entry.number) problems.push(`historical engine identity changed: ${entry.file}`);
  }
  return problems;
}

/** Say whether a repeated engine number is the named historical pair, so only that pair may share it [C7,V4]. */
function sharesNamedNumber(entry, engines) {
  const exception = HISTORICAL_DUPLICATE_ENGINES[entry.number];
  return Boolean(exception?.engines.includes(entry.name)) && engines.filter(other => other.number === entry.number).every(other => exception.engines.includes(other.name));
}
