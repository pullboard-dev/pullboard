/** Exact reviewed generated-data operands for one cells move; declarations never prove repository-source reads [C7,CD64]. */
import {
  cellExistsSync as existsSync,
  cellLstatSync as lstatSync,
  cellReadFileSync as readFileSync,
} from './cell/snapshot.js';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { storeName } from './store-names.js';

const KINDS = new Set(['hook', 'settings', 'spec', 'marker', 'config', 'HTML']);

/** Keep an exact row identity across files without normalizing its expression or line. */
export function dataReadKey(row) {
  return JSON.stringify([row.file, row.line, row.expression]);
}

/** Validate bounded declarative JSON; unsupported fields and duplicate identities fail closed. */
export function parseDataReads(value, label = 'generated-data manifest') {
  const problems = [], reads = [];
  if (!value || value.version !== 1 || !Array.isArray(value.reads) || value.reads.length > 512
    || Object.keys(value).some(key => !['version', 'reads'].includes(key))) {
    return { reads, problems: [`${label}: expected version 1 and at most 512 reads`] };
  }
  const seen = new Set();
  for (const [index, row] of value.reads.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).some(key => !['file', 'line', 'expression', 'kind', 'why'].includes(key))
      || typeof row.file !== 'string' || !/^[\w./-]+\.[cm]?js$/u.test(row.file)
      || row.file.split('/').some(part => !part || part === '.' || part === '..')
      || !Number.isSafeInteger(row.line) || row.line < 1
      || typeof row.expression !== 'string' || !row.expression.trim() || row.expression.length > 4096
      || !KINDS.has(row.kind) || typeof row.why !== 'string' || !row.why.trim() || row.why.length > 2000) {
      problems.push(`${label}: invalid read ${index + 1}`); continue;
    }
    const key = dataReadKey(row);
    if (seen.has(key)) { problems.push(`${label}: duplicate read ${row.file}:${row.line}`); continue; }
    seen.add(key); reads.push(row);
  }
  return { reads: problems.length ? [] : reads, problems };
}

/** Read only this cell's bounded regular manifest; absence preserves the original analyzer behavior. The caller supplies the snapshot-aware `tryGit`, since Git object scopes sit above this cell. */
export function readMoveDataReads(root, cell, tryGit) {
  const file = `packages/codemap/data/plan/data-reads/${storeName(cell)}`;
  const head = tryGit(root, ['rev-parse', 'HEAD']);
  if (head.status !== 0) return { reads: [], problems: [`${file}: cannot inspect the committed manifest`] };
  const tracked = tryGit(root, ['ls-tree', '-z', head.stdout, '--', file]);
  if (tracked.status !== 0) return { reads: [], problems: [`${file}: cannot inspect the committed manifest`] };
  const object = /^100(?:644|755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t/u.exec(tracked.stdout)?.[1];
  if (!tracked.stdout && !existsSync(join(root, file))) return { reads: [], problems: [] };
  if (!object) return { reads: [], problems: [`${file}: manifest must be a committed regular file`] };
  let path = root;
  for (const part of file.split('/')) {
    path = join(path, part);
    if (!existsSync(path)) return { reads: [], problems: [`${file}: committed manifest is missing`] };
    if (lstatSync(path).isSymbolicLink()) return { reads: [], problems: [`${file}: manifest path is a symbolic link`] };
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 128 * 1024) return { reads: [], problems: [`${file}: manifest must be a regular file of at most 128 KiB`] };
  try {
    const bytes = readFileSync(path);
    const actual = createHash(object.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (actual !== object || tryGit(root, ['rev-parse', 'HEAD']).stdout !== head.stdout) {
      return { reads: [], problems: [`${file}: manifest differs from its committed snapshot`] };
    }
    return parseDataReads(JSON.parse(bytes.toString('utf8')), file);
  }
  catch { return { reads: [], problems: [`${file}: invalid manifest JSON`] }; }
}

/** Match only the exact unresolved filesystem operand; callers must first reject resolved repository source. */
export function matchingDataRead(reads, file, source, range) {
  const line = source.slice(0, range.start).split('\n').length;
  const expression = source.slice(range.start, range.end);
  return reads.find(row => row.file === file && row.line === line && row.expression === expression);
}

/** Report declarations that were not consumed by an unresolved read, including deleted or newly proven inputs. */
export function staleDataReads(reads, matched) {
  const used = new Set(matched.map(dataReadKey));
  return reads.filter(row => !used.has(dataReadKey(row))).map(row => `${row.file}:${row.line}: stale generated-data manifest expression ${JSON.stringify(row.expression)}`);
}
