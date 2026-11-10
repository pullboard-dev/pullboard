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

/** List every event declaration below the events folder, one level of grouping folders included. */
function eventFiles(directory) {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name);
    if (lstatSync(path).isDirectory()) return /^[a-z][a-z0-9-]*$/u.test(name) ? eventFiles(path) : [];
    if (!name.endsWith('.json')) return [];
    if (!/^[a-z][a-z0-9_-]*\.json$/u.test(name) || !lstatSync(path).isFile()) throw new Error(`invalid event declaration ${name}`);
    return [path];
  });
}

/** Render event descriptions from independent per-kind files, retaining historical version annotations. */
function eventTable(root) {
  const kinds = new Set();
  const entries = eventFiles(join(root, 'apps/cli/src/io/documentation/events')).flatMap(path => {
    const row = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof row.kind !== 'string' || !/^[a-z][a-z0-9_-]*$/u.test(row.kind) || kinds.has(row.kind)
        || !Array.isArray(row.entries) || !row.entries.length) throw new Error(`invalid event identity ${path}`);
    kinds.add(row.kind);
    return row.entries.map(entry => {
      if (!Number.isSafeInteger(entry.order) || entry.order < 0 || typeof entry.actor !== 'string'
          || typeof entry.detail !== 'string') throw new Error(`invalid event description ${path}`);
      return { ...entry, kind: row.kind };
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
