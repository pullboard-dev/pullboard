/** Literal YAML block trees at the move boundary; stored review paths remain exact strings. */
import { createHash } from 'node:crypto';
import { Refused } from './refused.js';
import { COMPACT_VERDICT_REVIEW_ENGINE } from './compact-verdict-review-engine.js';

const FORMAT = 'pullboard-review-path-yaml-v1';
// Same maximum as the existing Git path-capture reader, not a worker resource quota.
const MAX_BYTES = 32 * 1024 * 1024;
/** Measure the UTF-8 wire size, including non-ASCII filenames. */
const bytes = text => new TextEncoder().encode(text).length;
/** Bind the complete expanded JSON array, not just the tree's leaves. */
const hash = text => createHash('sha256').update(text).digest('hex');
/** Refuse without guessing coverage or exposing any path. */
const bad = () => new Refused('BAD_VERDICT_REVIEW', 'the lossless review paths are invalid; retain the original move and restore its exact encoded paths');

/** Match the native review validator's literal repository-relative path grammar. */
function validPath(path) {
  return typeof path === 'string' && !path.includes('\0') && path.split('/').every(part => part && part !== '.' && part !== '..');
}

/** Quote literal keys; escape YAML line separators and non-printable C1 characters too. */
function quote(key) {
  return JSON.stringify(key).replace(/[\u007f-\u009f\u2028\u2029\ufffe\uffff]/gu, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Emit only a canonical YAML block-mapping subset, without recursive calls or prototype keys. */
function yamlTree(paths) {
  const root = { children: new Map(), leaf: false };
  for (const path of paths) {
    let node = root;
    for (const part of path.split('/')) {
      if (!node.children.has(part)) node.children.set(part, { children: new Map(), leaf: false });
      node = node.children.get(part);
    }
    node.leaf = true;
  }
  const lines = [], stack = [...root.children.keys()].sort().reverse().map(key => ({ key, node: root.children.get(key), depth: 0 }));
  while (stack.length) {
    const { key, node, depth } = stack.pop(), indent = '  '.repeat(depth);
    lines.push(`${indent}${quote(key)}:${node.children.size ? '' : ' null'}\n`);
    if (node.children.size) {
      // Empty component marks this exact path as well as its descendants (file/directory transitions).
      if (node.leaf) lines.push(`${indent}  "": null\n`);
      for (const child of [...node.children.keys()].sort().reverse())
        stack.push({ key: child, node: node.children.get(child), depth: depth + 1 });
    }
  }
  return lines.join('') || '{}\n';
}

/** Encode a sorted unique literal array without dropping or generalizing any path. */
export function compactReviewPaths(paths) {
  if (!Array.isArray(paths) || !paths.every(validPath) || JSON.stringify(paths) !== JSON.stringify([...new Set(paths)].sort())) throw bad();
  const text = JSON.stringify(paths), size = bytes(text);
  if (size > MAX_BYTES) throw bad();
  return { format: FORMAT, bytes: size, sha256: hash(text), yaml: yamlTree(paths) };
}

/** Read only the emitted subset; never interpret general YAML, aliases, tags or implicit scalars. */
function treePaths(yaml, limit) {
  if (yaml === '{}\n') return [];
  if (!yaml.endsWith('\n')) throw bad();
  const paths = [], stack = [{ path: '', previous: null }];
  let size = 2;
  for (const line of yaml.slice(0, -1).split('\n')) {
    const row = /^( *)("(?:[^"\\]|\\.)*"):( null)?$/u.exec(line);
    if (!row || row[1].length % 2) throw bad();
    const depth = row[1].length / 2;
    if (depth >= stack.length) throw bad();
    stack.length = depth + 1;
    let key;
    try { key = JSON.parse(row[2]); } catch { throw bad(); }
    const parent = stack[depth], leaf = row[3] !== undefined;
    if (quote(key) !== row[2] || parent.previous !== null && parent.previous >= key
        || key.includes('/') || key === '' && (!leaf || depth === 0) || key !== '' && !validPath(key)) throw bad();
    parent.previous = key;
    const path = key === '' ? parent.path : parent.path ? `${parent.path}/${key}` : key;
    if (leaf) {
      size += bytes(JSON.stringify(path)) + (paths.length ? 1 : 0);
      if (size > limit) throw bad();
      paths.push(path);
    } else stack.push({ path, previous: null });
  }
  return paths.sort();
}

/** Bound expansion and validate canonical shape, length and digest before native verification. */
export function expandReviewPaths(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'bytes,format,sha256,yaml' || value.format !== FORMAT
      || !Number.isSafeInteger(value.bytes) || value.bytes < 2 || value.bytes > MAX_BYTES
      || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sha256) || typeof value.yaml !== 'string') throw bad();
  const paths = treePaths(value.yaml, value.bytes), text = JSON.stringify(paths);
  if (bytes(text) !== value.bytes || hash(text) !== value.sha256 || yamlTree(paths) !== value.yaml) throw bad();
  return paths;
}

/** Compact only when smaller; preserve the caller's args and every other move field. */
export function compactReviewMove(move) {
  if (move.operation !== 'verify' || !Array.isArray(move.args?.[1]?.review?.paths)) return move;
  const paths = compactReviewPaths(move.args[1].review.paths);
  if (bytes(JSON.stringify(paths)) >= bytes(JSON.stringify(move.args[1].review.paths))) return move;
  return { ...move, engine: Math.max(move.engine, COMPACT_VERDICT_REVIEW_ENGINE), args: [move.args[0],
    { ...move.args[1], review: { ...move.args[1].review, paths } }, ...move.args.slice(2)] };
}

/** Stop a YAML envelope mislabeled as an older feature engine before receipt or cursor writes. */
export function requireCompactReviewEngine(move) {
  const paths = move?.operation === 'verify' ? move.args?.[1]?.review?.paths : undefined;
  if (paths !== undefined && !Array.isArray(paths) && move.engine < COMPACT_VERDICT_REVIEW_ENGINE)
    throw new Refused('ENGINE_VERSION', 'compact review paths require the lossless review-path engine; do not replay or discard this move with an older reader');
}

/** Expand only wire paths; the board and its freshness projector still receive the original array. */
export function expandReviewArgs(move, args) {
  requireCompactReviewEngine(move);
  if (move.operation === 'verify' && args[1]?.review && !Array.isArray(args[1].review.paths))
    args[1].review.paths = expandReviewPaths(args[1].review.paths);
  return args;
}
