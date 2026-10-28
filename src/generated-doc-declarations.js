/** Source-owned semantic descriptions complement facts derived directly from runtime declarations [C7,A5]. */
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { docTable } from './generated-doc-blocks.js';
import { ID_RE } from './spec.js';
import { STATUSES } from './spec.js';
import { TIERS } from './spec.js';
import { parseSpec } from './spec.js';

/** Read data-only source declarations, never Markdown output as generator input. */
function declaration(root, name) {
  const path = join(root, 'src', 'documentation', `${name}.json`);
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

/** Render event descriptions from independent per-kind files, retaining historical version annotations. */
function eventTable(root) {
  const directory = join(root, 'src', 'documentation', 'events');
  const entries = readdirSync(directory).filter(file => file.endsWith('.json')).sort().flatMap(file => {
    if (!/^[a-z][a-z0-9_-]*\.json$/u.test(file) || !lstatSync(join(directory, file)).isFile()) throw new Error(`invalid event declaration ${file}`);
    const row = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    if (file !== `${row.kind}.json` || !Array.isArray(row.entries) || !row.entries.length) throw new Error(`invalid event identity ${file}`);
    return row.entries.map(entry => {
      if (!Number.isSafeInteger(entry.order) || entry.order < 0 || typeof entry.actor !== 'string'
          || typeof entry.detail !== 'string') throw new Error(`invalid event description ${file}`);
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
