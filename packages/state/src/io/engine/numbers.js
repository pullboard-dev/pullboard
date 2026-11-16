/**
 * Engine numbers are given at landing, never picked by a builder (#1101).
 *
 * An item that adds a board move adds its own packages/state/src/logic/engines/<name>-engine.js leaf as `export const NAME_ENGINE =
 * unassignedEngine();`. On its branch the leaf reads as the trunk's highest engine plus one, so its tests run; the
 * landing merge then writes the next number into the leaf, in landing order, inside the item's merge commit. Two
 * items can never take the same number and none waits on a stale one; a landed number never changes, so moves
 * recorded under it replay as they were written.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  lstatSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  ENGINE_CANDIDATE,
  ENGINE_FILE,
  discovered,
} from '../../../../kernel/light.js';
import { storeName } from '../store-names.js';

/** The generated table of landed numbers the pure state doors read [C7]. */
export const ENGINE_TABLE = 'packages/state/src/logic/engine/table.js';

export { engineNumber } from '../../logic/engine/number.js';

/** The folder that holds the engine leaves, one constant per file so two items adding engines never conflict [V4]. */
export const ENGINE_FOLDER = 'packages/state/src/logic/engines';

/** The one declaration a leaf holds: a landed number, or the placeholder a branch carries until it lands. */
export const ENGINE_LINE = /^export const ([A-Z][A-Z0-9_]*_ENGINE) = (?:(\d+)|unassignedEngine\(\));$/u;
/** The import a placeholder leaf needs, removed when the leaf gets its number. */
export const UNASSIGNED_IMPORT = "import { unassignedEngine } from './engine-next.js';";

/**
 * Read every engine leaf in a directory.
 *
 * @param {string} directory
 * @returns {{ file: string, name: string, number: number | null }[]} By file name; `number` is null until it lands.
 */
export function readEngineLeaves(directory) {
  return discovered(readdirSync(directory), ENGINE_CANDIDATE, ENGINE_FILE, 'feature engine').map((file) => {
    const lines = readFileSync(join(directory, file), 'utf8').split('\n').filter((line) => /^export const /u.test(line));
    const match = lines.length === 1 ? ENGINE_LINE.exec(lines[0]) : null;
    if (!match) throw new Error(`${file} must declare exactly one line \`export const NAME_ENGINE = <number>;\`, or \`= unassignedEngine();\` until it lands, so ENGINE_VERSION can read it`);
    return { file, name: match[1], number: match[2] === undefined ? null : Number(match[2]) };
  });
}

/**
 * The number an unlanded leaf reads as: one above the highest landed number.
 *
 * @param {{ number: number | null }[]} leaves
 * @returns {number}
 */
export function nextEngineNumber(leaves) {
  return Math.max(0, ...leaves.map((leaf) => leaf.number ?? 0)) + 1;
}

/**
 * Give each unlanded leaf under `root`/ENGINE_FOLDER (one importing the placeholder) its number, next above the landed ones in file-name order, and keep the
 * documented move engine in docs/formats.md equal to the result. A tree with no unlanded leaf is left untouched.
 *
 * @param {string} root
 * @returns {{ files: string[], assigned: { name: string, number: number }[] }} The changed paths, relative to root.
 */
export function assignEngineNumbers(root) {
  const directory = join(root, ENGINE_FOLDER);
  if (!existsSync(directory)) return { files: [], assigned: [] };
  // Only a leaf that imports the placeholder is Pullboard's to number; any other file there is never read as a leaf.
  const texts = readdirSync(directory).filter((file) => ENGINE_CANDIDATE.test(file)).sort()
    .map((file) => ({ file, text: readFileSync(join(directory, file), 'utf8') }));
  const leaves = texts.map(({ file, text }) => {
    const lines = text.split('\n').filter((line) => /^export const /u.test(line));
    const match = lines.length === 1 ? ENGINE_LINE.exec(lines[0]) : null;
    if (!match) return null;
    const number = match[2] === undefined ? null : Number(match[2]);
    if (number === null && !text.split('\n').includes(UNASSIGNED_IMPORT)) return null;
    return { file, name: match[1], number };
  }).filter(Boolean);
  const unlanded = leaves.filter((leaf) => leaf.number === null);
  if (!unlanded.length) return { files: [], assigned: [] };
  let next = nextEngineNumber(leaves) - 1;
  const files = [];
  const assigned = [];
  for (const leaf of unlanded) {
    next += 1;
    const path = join(directory, leaf.file);
    const before = readFileSync(path, 'utf8');
    const text = before.split('\n').filter((line) => line !== UNASSIGNED_IMPORT).join('\n')
      .replace(/^(export const [A-Z][A-Z0-9_]*_ENGINE = )unassignedEngine\(\);$/mu, `$1${next};`);
    writeFileSync(path, text);
    leaf.number = next;
    let history;
    try { history = appendRegistryHistory(root, leaf, leaves); } catch (error) {
      // A refused source or existing record must leave the placeholder available for an ordinary retry.
      writeFileSync(path, before);
      leaf.number = null;
      throw error;
    }
    files.push(`${ENGINE_FOLDER}/${leaf.file}`, ...history);
    assigned.push({ name: leaf.name, number: next });
  }
  const table = join(root, ENGINE_TABLE);
  if (existsSync(table)) { writeFileSync(table, engineTableSource(leaves)); files.push(ENGINE_TABLE); }
  const formats = join(root, 'docs', 'formats.md');
  if (existsSync(formats)) {
    const text = readFileSync(formats, 'utf8');
    const updated = text.replace(/^(\| `move engine` \| `)\d+(` \|)/mu, `$1${next}$2`);
    if (updated !== text) { writeFileSync(formats, updated); files.push('docs/formats.md'); }
  }
  return { files, assigned };
}

/**
 * The source of the generated table: every landed leaf's number by name, in name order.
 *
 * @param {{ name: string, number: number | null }[]} leaves
 * @returns {string}
 */
export function engineTableSource(leaves) {
  const rows = leaves.filter(leaf => leaf.number !== null).sort((a, b) => a.name < b.name ? -1 : 1).map(leaf => `  ${leaf.name}: ${leaf.number},`);
  return `${TABLE_HEADER}${rows.join('\n')}\n});\n`;
}
const TABLE_HEADER = `/**
 * Every landed engine number by its leaf's constant, so the state doors read a number without loading its leaf [C7].
 * Generated by the landing merge (assignEngineNumbers) from packages/state/src/logic/engines/*-engine.js, which stay the only
 * place a number is decided; never edit by hand.
 */
export const ENGINE_NUMBERS = Object.freeze({
`;

/** Where numbered engine histories are written, and the 0.9.3 folder that is still read when a board has it [C7]. */
const HISTORY_FOLDER = 'packages/state/data/history';
const OLD_HISTORY_FOLDER = 'src/move-history';

/** Folders that hold move declarations: the old src/moves shims (gone since the layout freeze) and the moves cell's bodies [C7]. */
const MOVE_FOLDERS = Object.freeze(['src/moves', 'packages/moves/src/logic/moves', 'packages/moves/src/io/moves']);

/**
 * Freeze source metadata at allocation, without importing or executing the candidate tree.
 * The legacy record opts Pullboard itself into this format; unrelated projects are untouched.
 * Each landing writes a new path, never a shared manifest or a previously shipped record.
 */
function appendRegistryHistory(root, engine, leaves) {
  const directory = join(root, HISTORY_FOLDER);
  // A 0.9.3 board keeps its record under src/move-history: it is read there, and every new snapshot is written to the new folder [C7].
  if (!existsSync(join(directory, 'legacy.json')) && !existsSync(join(root, OLD_HISTORY_FOLDER, 'legacy.json'))) return [];
  const legacy = existsSync(join(directory, 'legacy.json')) ? directory : join(root, OLD_HISTORY_FOLDER);
  mkdirSync(directory, { recursive: true });
  const folders = MOVE_FOLDERS.map(folder => join(root, folder)).filter(path => existsSync(path));
  // The root src/ folder is gone since the layout freeze; only the history folder and the move folders must be real [V32].
  if (!folders.length || ![directory, ...folders].every(path => lstatSync(path).isDirectory())
      || !lstatSync(join(legacy, 'legacy.json')).isFile()) throw new Error('registry history requires regular source directories and a regular legacy record');
  // A packaged body replaces its src/moves shim of the same name, so the record is the same with or without the shims.
  const sources = new Map();
  for (const moves of folders) for (const file of discovered(readdirSync(moves), /\.js$/u, /^[\w-]+\.js$/u, 'move')) {
    if (!lstatSync(join(moves, file)).isFile()) throw new Error(`${file} must be a regular move declaration, never a source symlink`);
    sources.set(file, join(moves, file));
  }
  const declarations = Object.fromEntries([...sources.keys()].sort().map(file => [file, readFileSync(sources.get(file), 'utf8')]));
  const record = { version: 1, engine: engine.number, name: engine.name,
    engines: leaves.filter(leaf => leaf.number !== null).map(({ file, name, number }) => ({ file, name, number })), declarations };
  const relative = `${HISTORY_FOLDER}/${storeName(engine.number)}`;
  writeFileSync(join(root, relative), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  return [relative];
}
