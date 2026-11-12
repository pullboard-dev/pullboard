/** Source-owned semantic descriptions complement facts derived directly from runtime declarations [C7,A5]. */
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { docTable } from '../../logic/generated/doc/blocks.js';
import { ID_RE } from '../../../../../packages/spec/index.js';
import { STATUSES } from '../../../../../packages/spec/index.js';
import { TIERS } from '../../../../../packages/spec/index.js';
import { parseSpec } from '../../../../../packages/spec/index.js';

/** The declaration files whose names the layout move shortened; the table names stay as the guides cite them. */
const DECLARATION_FILES = { 'parser-fields': 'fields', 'upgrade-rules': 'rules', 'snapshot-files': 'snapshot' };

/** Read data-only source declarations, never Markdown output as generator input. */
function declaration(root, name) {
  const path = join(root, `apps/cli/src/io/documentation/${DECLARATION_FILES[name] ?? name}.json`);
  if (!lstatSync(path).isFile()) throw new Error(`${name} documentation must be a regular source declaration`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Pair source descriptions with actual parser identities; missing documentation fails generation. */
function namedTable(root, name, heading, names) {
  const rows = declaration(root, name);
  if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.length !== 2
      || row.some(cell => typeof cell !== 'string' || !cell))) throw new Error(`invalid ${name} declarations`);
  const identities = rows.map(row => row[0].replaceAll('`', ''));
  if (names && (identities.length !== names.length || identities.some((id, index) => id !== names[index]))) {
    throw new Error(`${name} documentation must describe exactly the actual declaration identities`);
  }
  return docTable(heading, rows);
}

/** The current and frozen legacy roots identify an event declaration by its full path [A5,C7]. */
const EVENT_DIRECTORY = 'apps/cli/src/io/documentation/events';
const LEGACY_EVENT_DIRECTORY = 'apps/cli/src/shell/documentation/events';

/** Collect nested declaration files without following symlinks or accepting malformed directories. */
function eventFiles(root, relative = '') {
  const directory = join(root, EVENT_DIRECTORY, relative);
  return readdirSync(directory).sort().flatMap(name => {
    const file = relative ? `${relative}/${name}` : name;
    const stat = lstatSync(join(directory, name));
    if (stat.isSymbolicLink()) throw new Error(`invalid event declaration ${file}`);
    if (stat.isDirectory()) {
      if (!/^[a-z][a-z0-9_-]*$/u.test(name)) throw new Error(`invalid event declaration ${file}`);
      return eventFiles(root, file);
    }
    if (!name.endsWith('.json')) return [];
    if (!/^[a-z][a-z0-9_-]*\.json$/u.test(name) || !stat.isFile()) throw new Error(`invalid event declaration ${file}`);
    return [file];
  });
}

/** Render event descriptions from independent per-kind files, retaining historical version annotations. */
function eventTable(root) {
  const directory = join(root, EVENT_DIRECTORY);
  const map = JSON.parse(readFileSync(join(root, 'packages/codemap/data/plan/path-map/freeze.json'), 'utf8'));
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('invalid frozen event path map');
  const kinds = new Set();
  const entries = eventFiles(root).flatMap(file => {
    const row = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    const kind = row?.kind;
    if (typeof kind !== 'string' || !/^[a-z][a-z0-9_-]*$/u.test(kind)) throw new Error(`invalid event identity ${file}`);
    const oldPath = `${LEGACY_EVENT_DIRECTORY}/${kind}.json`;
    const expected = Object.hasOwn(map, oldPath) ? map[oldPath] : `${EVENT_DIRECTORY}/${kind}.json`;
    const actual = `${EVENT_DIRECTORY}/${file}`;
    if (typeof expected !== 'string' || !expected.startsWith(`${EVENT_DIRECTORY}/`) || expected.split('/').some(part => !part || part === '.' || part === '..')
      || actual !== expected || kinds.has(kind) || !Array.isArray(row.entries) || !row.entries.length) throw new Error(`invalid event identity ${file}`);
    kinds.add(kind);
    return row.entries.map(entry => {
      if (!Number.isSafeInteger(entry.order) || entry.order < 0 || typeof entry.actor !== 'string'
          || typeof entry.detail !== 'string') throw new Error(`invalid event description ${file}`);
      return { ...entry, kind };
    });
  }).sort((a, b) => a.order - b.order || a.kind.localeCompare(b.kind));
  return docTable(['Kind', 'Actor', 'Detail fields'], entries.map(entry => [`\`${entry.kind}\``, entry.actor, entry.detail]));
}

/** Generate semantic tables while deriving parser keys and regex spelling from their implementation. */
export function declarationDocBlocks(root) {
  const row = parseSpec('## G\n- G1 [approved, must] A row. | gate: test | serves: G2 | signers: person@example.invalid\n').rows[0];
  return {
    'id-pattern': docTable(['Identifier', 'Parser expression'], [['`ID`', `\`${ID_RE.source}\``]]),
    statuses: namedTable(root, 'statuses', ['Status', 'Meaning'], STATUSES),
    tiers: namedTable(root, 'tiers', ['Tier', 'Meaning'], TIERS),
    'parser-fields': namedTable(root, 'parser-fields', ['Parsed field', 'Meaning'], Object.keys(row)),
    'upgrade-rules': namedTable(root, 'upgrade-rules', ['Older board condition', 'Behavior when opened']),
    'snapshot-files': namedTable(root, 'snapshot-files', ['File below `DIR`', 'Contents and reader']),
    events: eventTable(root),
  };
}
