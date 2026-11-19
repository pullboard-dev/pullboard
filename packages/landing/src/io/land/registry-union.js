/** Union two items' new test-registry records when a land merge stopped on nothing else [C7,U148]. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryGit } from '../../../../git/index.js';
import { IDENTITY } from './merge-args.js';

/** A registry file sits directly in a cell's tests/fixtures folder and is named registry*.json. */
const REGISTRY_PATH = /(?:^|\/)tests\/fixtures\/registry[^/]*\.json$/u;
/** One record per line: the quoted key, a colon, the value, and a trailing comma on all but the last line. */
const RECORD_LINE = /^(\s*)("(?:[^"\\]|\\.)*")\s*:\s.*$/u;

/** Parse a registry's text into its lines as `{ key, text }` records, or null when it is not one record per line. */
function records(text) {
  const lines = text.split('\n');
  if (lines.at(-1) !== '' || lines[0] !== '{' || lines.at(-2) !== '}') return null;
  const found = [];
  for (const line of lines.slice(1, -2)) {
    if (!RECORD_LINE.test(line)) return null;
    const body = line.endsWith(',') ? line.slice(0, -1) : line;
    let key;
    try { key = Object.keys(JSON.parse(`{${body}}`))[0]; } catch { return null; }
    if (key === undefined) return null;
    found.push({ key, text: body });
  }
  return found;
}

/** The text of records written back one per line, commas between and a final newline. */
const written = rows => `{\n${rows.map(row => row.text).join(',\n')}${rows.length ? '\n' : ''}}\n`;

/** One stage of a conflicted path (2 is main's side, 3 the item's), with its trailing newline kept; null when absent. */
function stage(root, number, file) {
  const spec = `:${number}:${file}`;
  const shown = tryGit(root, ['show', spec]);
  const size = tryGit(root, ['cat-file', '-s', spec]);
  if (shown.status !== 0 || size.status !== 0) return null;
  const extra = Number(size.stdout) - Buffer.byteLength(shown.stdout);
  return extra === 0 || extra === 1 ? shown.stdout + '\n'.repeat(extra) : null;
}

/** The union of main's rows and the item's rows whose keys main lacks; null when a side is not a one-record-per-line registry. */
function union(mainText, itemText) {
  const main = records(mainText);
  const item = records(itemText);
  if (main === null || item === null || written(main) !== mainText) return null;
  const known = new Set(main.map(row => row.key));
  const keys = main.map(row => row.key);
  const sorted = keys.every((key, index) => index === 0 || keys[index - 1] < key);
  const merged = [...main];
  for (const row of item.filter(row => !known.has(row.key))) {
    const at = sorted ? merged.findIndex(other => other.key > row.key) : -1;
    merged.splice(at === -1 ? merged.length : at, 0, row);
  }
  const text = written(merged);
  try { JSON.parse(text); } catch { return null; }
  return text;
}

/**
 * When a merge in `root` stopped and every conflicted path is a cell test registry, write each as main's side byte-exact
 * plus the item's records whose keys main lacks (key order kept when main's was sorted), stage them and return true.
 * Any other conflict, or a side that does not parse, changes nothing and returns false.
 * Why: registries only gain records, so two items adding different records is never a real conflict [C7,U148].
 */
export function unionRegistryConflict(root) {
  const listed = tryGit(root, ['diff', '--name-only', '--diff-filter=U']);
  const files = listed.stdout.split('\n').filter(Boolean);
  if (listed.status !== 0 || files.length === 0 || !files.every(file => REGISTRY_PATH.test(file))) return false;
  const results = [];
  for (const file of files) {
    const main = stage(root, 2, file);
    const item = stage(root, 3, file);
    const text = main === null || item === null ? null : union(main, item);
    if (text === null) return false;
    results.push([file, text]);
  }
  for (const [file, text] of results) writeFileSync(join(root, file), text);
  return tryGit(root, ['add', '--', ...results.map(([file]) => file)]).status === 0;
}

/** Finish a stopped merge whose registry conflicts unionRegistryConflict resolved; true when the merge commit was made. */
export function commitUnionedMerge(root) {
  return unionRegistryConflict(root) && tryGit(root, [...IDENTITY, 'commit', '--no-edit', '-q']).status === 0;
}
