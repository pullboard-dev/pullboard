/** Shared conservative data-only conflict decisions; candidate generators run only during landing [B3,R3,C7]. */
import { mergeManifestRows } from '../logic/manifest.js';
import { rowManifest } from '../logic/manifest.js';
import { generatedDocResolution } from '../logic/conflicts.js';
import { generatedDocCommand } from '../logic/conflicts.js';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanGitEnvironment } from '../../../git/index.js';
import { formatJson } from '../../../codemap/light.js';

export { formatJson };

/** Version four adds plan-shard rows and config defaults; older receipts replay with the older policy [H16]. */
export const MECHANICAL_VERSION = 4;
const PLAN_SHARD = /^packages\/codemap\/data\/plan\/[a-z0-9-]+\.json$/u;
const PLAN_READS = /^packages\/codemap\/data\/plan\/data-reads\/[a-z0-9:-]+\.json$/u;

/**
 * The defaults object's top-level settings, each with the comment lines above it and the lines nested under it.
 * Two items adding different settings then never touch the same lines [C7].
 */
function configEntries(lines, start, end) {
  const entries = [];
  let pending = [];
  for (const line of lines.slice(start + 1, end)) {
    const key = /^ {4}([A-Za-z_][A-Za-z0-9_]*): /u.exec(line)?.[1];
    if (key) { entries.push({ key, line: [...pending, line].join('\n') }); pending = []; }
    else if (/^ {4}\/\/ /u.test(line)) pending.push(line);
    else if (entries.length && !pending.length && /^ {5,}\S|^ {4}[}\]]/u.test(line)) entries.at(-1).line += '\n' + line;
    else return null;
  }
  return pending.length ? null : entries;
}

/** The defaults() file: its place now, and the old root path so a replay of an older landing reads the same region. */
const CONFIG_DEFAULTS_FILES = new Set(['packages/config/src/io/main.js', 'src/config.js']);

/** Locate a known keyed region without interpreting or executing candidate JavaScript. */
function region(path, source, version = MECHANICAL_VERSION) {
  const lines = source.split('\n');
  let start;
  let end;
  let key;
  if (CONFIG_DEFAULTS_FILES.has(path) && version >= 4) {
    start = lines.indexOf('export function defaults() {') + 1;
    if (lines[start] !== '  return {') return null;
    end = lines.indexOf('  };', start + 1);
    const entries = start > 0 && end > start ? configEntries(lines, start, end) : null;
    if (!entries || new Set(entries.map(entry => entry.key)).size !== entries.length) return null;
    return { prefix: lines.slice(0, start + 1).join('\n'), suffix: lines.slice(end).join('\n'), entries };
  }
  if (path === 'src/api-moves.js') {
    start = lines.indexOf('const MOVES = {');
    end = lines.indexOf('};', start + 1);
    const field = "(?:[A-Za-z][A-Za-z0-9]*): (?:true|false|\\[(?:'[A-Za-z0-9-]+'(?:, '[A-Za-z0-9-]+')*)?\\])";
    const entry = new RegExp(`^  (?:'([a-z][a-z0-9-]*)'|([A-Za-z][A-Za-z0-9]*)): \\{ ${field}(?:, ${field})* \\},$`, 'u');
    key = line => entry.exec(line)?.slice(1).find(Boolean);
  } else if (path === 'docs/formats.md') {
    start = lines.indexOf('| Format | Version | Version source | Upgrade rule |');
    if (lines[start + 1] !== '| --- | --- | --- | --- |') return null;
    start += 1;
    end = lines.indexOf('<!-- format-versions:end -->', start + 1);
    key = line => /^\| `([^`|]+)` \| `\d+` \| .+ \| .+ \|$/u.exec(line)?.[1];
  } else return null;
  if (start < 0 || end <= start) return null;
  const entries = lines.slice(start + 1, end).map(line => ({ key: key(line), line }));
  if (entries.some(entry => !entry.key) || new Set(entries.map(entry => entry.key)).size !== entries.length) return null;
  return { prefix: lines.slice(0, start + 1).join('\n'), suffix: lines.slice(end).join('\n'), entries };
}

/** Only insertions are admissible: every original entry and every surrounding byte stays unchanged. */
function additions(base, side) {
  if (!side || side.prefix !== base.prefix || side.suffix !== base.suffix) return null;
  const original = new Map(base.entries.map(entry => [entry.key, entry.line]));
  let position = 0;
  const gaps = Array.from({ length: base.entries.length + 1 }, () => []);
  for (const entry of side.entries) {
    if (original.has(entry.key)) {
      if (base.entries[position]?.key !== entry.key || original.get(entry.key) !== entry.line) return null;
      position += 1;
    } else gaps[position].push(entry);
  }
  return position === base.entries.length ? gaps : null;
}

/** Preserve both contributors' entry order, using the key only to break independent insertion ties. */
function mergeGap(left, right) {
  const entries = new Map();
  const edges = new Map();
  for (const side of [left, right]) {
    for (const entry of side) {
      if (entries.has(entry.key) && entries.get(entry.key) !== entry.line) return null;
      entries.set(entry.key, entry.line);
      if (!edges.has(entry.key)) edges.set(entry.key, new Set());
    }
    for (let index = 1; index < side.length; index += 1) edges.get(side[index - 1].key).add(side[index].key);
  }
  const result = [];
  while (entries.size) {
    const key = [...entries.keys()].sort().find(candidate => ![...edges.values()].some(next => next.has(candidate)));
    if (key === undefined) return null;
    result.push({ key, line: entries.get(key) });
    entries.delete(key);
    edges.delete(key);
  }
  return result;
}

/** Return a union only when all three exact sources differ solely by permitted keyed insertions. */
export function mergeMechanicalSources(path, ancestor, ours, theirs, version = MECHANICAL_VERSION) {
  const base = region(path, ancestor, version);
  if (!base) return null;
  const left = additions(base, region(path, ours, version));
  const right = additions(base, region(path, theirs, version));
  if (!left || !right) return null;
  const locations = new Map();
  const entries = [];
  for (let index = 0; index < left.length; index += 1) {
    const gap = mergeGap(left[index], right[index]);
    if (!gap) return null;
    for (const entry of gap) {
      if (locations.has(entry.key) && locations.get(entry.key) !== index) return null;
      locations.set(entry.key, index);
      entries.push(entry);
    }
    if (base.entries[index]) entries.push(base.entries[index]);
  }
  if (!locations.size) return null;
  return { source: [base.prefix, ...entries.map(entry => entry.line), base.suffix].join('\n'), keys: [...locations.keys()] };
}

const MISSING = Symbol('missing');
const CONFLICT = Symbol('conflict');
const GENERATED = new Map([['docs/lifecycle.md', ['apps/cli/pullboard.js', 'lifecycle']]]);

/** Refuse numeric data JavaScript cannot faithfully round-trip instead of silently changing an untouched value. */
function snapshot(source) {
  return JSON.parse(source, (_key, value) => {
    if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
      throw new Error('snapshot number cannot round-trip exactly');
    }
    return value;
  });
}

/** Compare JSON values structurally, without confusing absent keys with explicit null. */
function identity(value) {
  if (value === MISSING) return MISSING;
  if (Array.isArray(value)) return `[${value.map(identity).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${identity(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** A plan row is named by its path (array rows), its first value (object rows) or itself (text rows). */
function rowName(row) {
  // A data-read row is one read: its file, line and expression together, since a file carries many reads.
  if (row !== null && typeof row === 'object' && !Array.isArray(row) && 'file' in row && 'line' in row && 'expression' in row) return identity([row.file, row.line, row.expression]);
  if (Array.isArray(row)) return identity(row[0]);
  if (row !== null && typeof row === 'object') return identity(Object.values(row)[0]);
  return identity(row);
}

/** Both sides changing or adding the same named row differently is a real edit of one row, never a union. */
function rowCollision(base, ours, theirs) {
  const original = new Map(base.map(row => [rowName(row), identity(row)]));
  const right = new Map(theirs.map(row => [rowName(row), identity(row)]));
  const left = new Map(ours.map(row => [rowName(row), identity(row)]));
  const changed = ours.some(row => {
    const name = rowName(row), mine = identity(row), other = right.get(name);
    return other !== undefined && other !== mine && original.get(name) !== mine && original.get(name) !== other;
  });
  // A row one side removes while the other side changes it is a real edit of that row too.
  const removed = [...original].some(([name, was]) => (!left.has(name) && right.has(name) && right.get(name) !== was)
    || (!right.has(name) && left.has(name) && left.get(name) !== was));
  return changed || removed;
}

/** Merge snapshot data; deletions win only over unchanged values, and only jointly raised counters use max. */
function jsonValue(base, ours, theirs, rows = false) {
  if (identity(ours) === identity(theirs)) return ours;
  if (identity(ours) === identity(base)) return theirs;
  if (identity(theirs) === identity(base)) return ours;
  if (ours === MISSING || theirs === MISSING) return CONFLICT;
  if (Array.isArray(ours) && Array.isArray(theirs) && (Array.isArray(base) || base === MISSING)) {
    if (rows && rowCollision(base === MISSING ? [] : base, ours, theirs)) return CONFLICT;
    const old = new Set((base === MISSING ? [] : base).map(identity));
    const left = new Set(ours.map(identity)), right = new Set(theirs.map(identity));
    const result = new Map();
    for (const value of [...ours, ...theirs]) {
      const key = identity(value);
      if (!old.has(key) || (left.has(key) && right.has(key))) result.set(key, value);
    }
    return [...result.values()];
  }
  const object = value => value !== null && value !== MISSING && typeof value === 'object' && !Array.isArray(value);
  if (object(ours) && object(theirs) && (object(base) || base === MISSING)) {
    const original = base === MISSING ? {} : base;
    const result = Object.create(null);
    for (const key of new Set([...Object.keys(original), ...Object.keys(ours), ...Object.keys(theirs)])) {
      const merged = jsonValue(Object.hasOwn(original, key) ? original[key] : MISSING,
        Object.hasOwn(ours, key) ? ours[key] : MISSING, Object.hasOwn(theirs, key) ? theirs[key] : MISSING, rows);
      if (merged === CONFLICT) return CONFLICT;
      if (merged !== MISSING) result[key] = merged;
    }
    return result;
  }
  if ([base, ours, theirs].every(value => typeof value === 'number') && ours > base && theirs > base) return Math.max(ours, theirs);
  return CONFLICT;
}

/** Union only conflicts whose ancestor hunk is empty; replacements and deletions remain conflicts. */
function additiveSource(base, ours, theirs) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-merge-data-'));
  try {
    const paths = [ours, base, theirs].map((source, index) => {
      const path = join(directory, String(index));
      writeFileSync(path, source, { mode: 0o600 });
      return path;
    });
    const label = randomUUID();
    const merged = spawnSync('git', ['merge-file', '-p', '--diff3', '-L', label, '-L', label, '-L', label, ...paths],
      { env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (merged.status === 0) return merged.stdout;
    if (merged.status === null || merged.status < 1 || merged.status > 127) return null;
    const lines = merged.stdout.split(/(?<=\n)/u);
    const result = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index] !== `<<<<<<< ${label}\n`) { result.push(lines[index]); continue; }
      const left = [], original = [], right = [];
      while (++index < lines.length && lines[index] !== `||||||| ${label}\n`) left.push(lines[index]);
      while (++index < lines.length && lines[index] !== '=======\n') original.push(lines[index]);
      while (++index < lines.length && lines[index] !== `>>>>>>> ${label}\n`) right.push(lines[index]);
      if (index >= lines.length || original.length) return null;
      result.push(...left, ...right);
    }
    return result.join('');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Resolve only declared generated output, structural JSON or genuine additions; never execute candidate code. */
function sourceResolution(path, base, ours, theirs, version = MECHANICAL_VERSION) {
  if (GENERATED.has(path)) return { kind: 'generated', keys: [] };
  if (version >= 3) {
    const generated = generatedDocResolution(path, base, ours, theirs);
    if (generated) return generated;
  }
  if (path.endsWith('.json')) {
    try {
      const plan = version >= 4 && PLAN_SHARD.test(path);
      const merged = jsonValue(snapshot(base), snapshot(ours), snapshot(theirs), plan || (version >= 4 && PLAN_READS.test(path)));
      if (merged === CONFLICT) return null;
      if (plan) return { kind: 'json', keys: Object.keys(merged ?? {}), source: formatJson(merged) + '\n' };
      const indent = /\n([ \t]+)\S/u.exec(ours)?.[1];
      return { kind: 'json', keys: Object.keys(merged ?? {}), source: JSON.stringify(merged, null, indent) + (ours.endsWith('\n') ? '\n' : '') };
    } catch { return null; /* Invalid snapshots remain ordinary conflicts, never guessed data. */ }
  }
  const keyed = mergeMechanicalSources(path, base, ours, theirs, version);
  // A defaults object has one value per key: two differing additions of a key never union into a duplicate.
  if (!keyed && CONFIG_DEFAULTS_FILES.has(path) && version >= 4 && region(path, base, version)) return null;
  const source = keyed?.source ?? additiveSource(base, ours, theirs);
  if (source === null) return null;
  if (/\.(?:js|mjs|cjs)$/u.test(path)) {
    const args = path.endsWith('.cjs') ? ['--check'] : ['--input-type=module', '--check'];
    if (spawnSync(process.execPath, args, { input: source, env: cleanGitEnvironment(), maxBuffer: 1024 * 1024 }).status !== 0) return null;
  }
  return keyed ? { kind: 'keyed', ...keyed } : { kind: 'add-only', source, keys: [] };
}

/** Run Git against explicit immutable objects, never inherited repository selectors or replacement refs. */
function gitData(root, args, gitDirectory) {
  return spawnSync('git', ['--no-replace-objects', ...(gitDirectory ? [`--git-dir=${gitDirectory}`] : []), '-c', 'core.quotepath=false', ...args],
    { cwd: root, env: cleanGitEnvironment(), maxBuffer: 32 * 1024 * 1024 });
}

/** The merged text of one plan data file, or the path when both sides changed the same entry; the landing's own decision [C7,D3]. */
export function mergePlanData(path, ancestor, ours, theirs) {
  const resolution = sourceResolution(path, ancestor, ours, theirs);
  return resolution?.source === undefined ? { conflicts: [path] } : { source: resolution.source };
}

/** Read exactly three regular-file stages with identical modes and valid UTF-8, refusing deletes and symlinks. */
function stageResolution(root, path, records, gitDirectory, version = MECHANICAL_VERSION, orderedData = false) {
  if (records.length !== 3 || records.some((record, index) => record.stage !== index + 1 || record.mode !== records[0].mode)
    || !['100644', '100755'].includes(records[0].mode)) return null;
  const sources = records.map(record => gitData(root, ['cat-file', 'blob', record.hash], gitDirectory));
  if (sources.some(result => result.status !== 0 || !Buffer.isBuffer(result.stdout)
    || !Buffer.from(result.stdout.toString('utf8'), 'utf8').equals(result.stdout))) return null;
  const text = sources.map(result => result.stdout.toString('utf8'));
  if (orderedData && rowManifest(path)) {
    const merged = mergeManifestRows(path, ...text);
    return merged.conflicts ? { kind: 'row-conflict', conflicts: merged.conflicts } : { kind: 'json', ...merged };
  }
  return sourceResolution(path, ...text, version);
}

/** Parse Git's stage records using NUL framing, retaining unusual path bytes and original conflict order. */
function stages(output) {
  const byPath = new Map();
  for (const record of output) {
    const match = /^(\d+) ([a-f0-9]+) ([123])\t([\s\S]+)$/u.exec(record);
    if (!match) continue;
    if (!byPath.has(match[4])) byPath.set(match[4], []);
    byPath.get(match[4]).push({ mode: match[1], hash: match[2], stage: Number(match[3]) });
  }
  return byPath;
}

/**
 * Classify the same virtual merge for health and immutable replay without touching any index or checkout.
 * With `raw`, name every file Git itself reports as conflicting, including those a mechanical rule would
 * resolve at landing: a coordinator's `reopen --conflict` answers to Git's report, not to the landing's [C7].
 */
export function mechanicalConflictFiles(root, trunk, head, { gitDirectory, version = MECHANICAL_VERSION, raw = false } = {}) {
  const result = gitData(root, ['merge-tree', '--write-tree', '-z', trunk, head], gitDirectory);
  const output = result.stdout?.toString('utf8').split('\0') ?? [];
  if (![0, 1].includes(result.status) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(output[0]?.trim() ?? '')) return null;
  if (result.status === 0) return [];
  const end = output.indexOf('', 1);
  const entries = stages(output.slice(1, end < 0 ? undefined : end));
  if (!entries.size) return null;
  if (raw) return [...entries.keys()];
  return [...entries].filter(([path, records]) => !stageResolution(root, path, records, gitDirectory, version)).map(([path]) => path);
}

/** Resolve a landing index using the identical decisions; generators execute only in this about-to-be-gated tree. */
export function resolveMechanicalIndex(root, files, { orderedData = false } = {}) {
  const result = gitData(root, ['ls-files', '--stage', '-z', '--', ...files]);
  const entries = stages(result.stdout?.toString('utf8').split('\0') ?? []);
  const resolutions = [], remaining = [], rowConflicts = [];
  for (const path of files) {
    const resolution = result.status === 0 ? stageResolution(root, path, entries.get(path) ?? [], undefined, MECHANICAL_VERSION, orderedData) : null;
    if (resolution?.kind === 'row-conflict') {
      remaining.push(path);
      rowConflicts.push(`${path}: ${resolution.conflicts.join(', ')}`);
    } else if (resolution) resolutions.push({ path, ...resolution });
    else remaining.push(path);
  }
  if (remaining.length) return { files: remaining, entries: [], ...(rowConflicts.length ? { rowConflicts } : {}) };
  for (const entry of resolutions.filter(entry => entry.source !== undefined)) writeFileSync(join(root, entry.path), entry.source);
  for (const entry of resolutions.filter(entry => entry.kind === 'generated')) {
    const command = GENERATED.get(entry.path) ?? generatedDocCommand(entry.path);
    const generated = spawnSync(process.execPath, command,
      { cwd: root, env: cleanGitEnvironment(), timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    if (generated.status !== 0) return { files: [], entries: [], failed: {
      path: entry.path, generator: command.join(' '), status: generated.status,
    } };
    writeFileSync(join(root, entry.path), generated.stdout);
  }
  return { files: [], entries: resolutions.map(({ path, keys, kind }) => ({ path, keys, kind })) };
}

/** Preserve the legacy all-or-nothing landing API and its resolution receipt entries. */
export function resolveMechanicalMerge(root, files) {
  const result = resolveMechanicalIndex(root, files);
  return result.failed || result.files.length ? null : result.entries;
}

