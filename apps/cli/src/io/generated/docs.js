/** One generation boundary for source-owned format, API, and help declarations [C7,A1,A5,M1]. */
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
import { fileURLToPath } from 'node:url';
import { closeBoard } from '../../../../../packages/store/index.js';
import { JSON_SHAPES } from '../../../../../packages/config/index.js';
import { formatTable } from '../../../../../packages/state/index.js';
import { commandHelpModule } from '../docs.js';
import { shapeTable } from '../../logic/generated/doc/blocks.js';
import { schemaDocBlocks } from '../../logic/generated/doc/schema.js';
import { declarationDocBlocks } from './declarations.js';
import { API_NOTES } from './api-notes.js';
import { HTTP_PATHS } from './api-notes.js';

const files = fileSystemAdapter();

/** A marked generated table as the page holds it. */
function marked(blocks, name) {
  return [`<!-- ${name}:start -->`, blocks[name].trimEnd(), `<!-- ${name}:end -->`, ''];
}

/** A section that only points at its own page, the form the section takes once the page is its only copy. */
function linkSection(title, sentence) {
  return [`## ${title}`, '', sentence, ''];
}

/** The formats guide: headings and the page links held here, its schema, version and event tables rendered from the declarations; the authored prose is dropped [C7]. */
export function formatsPage(blocks) {
  const bare = title => [`## ${title}`, ''];
  const table = (title, name) => [`### ${title}`, '', ...marked(blocks, name)];
  return [
    '# File formats',
    '',
    'Every table on this page is generated from source declarations by `node docs/tools/update-docs.js`; change the declarations, not the page. `--check` reports a stale copy without writing.',
    '',
    ...linkSection('SPEC.md and DOCTRINE.md', 'The row grammar, statuses, tiers, signers and id namespaces are on [docs/formats/spec.md](formats/spec.md).'),
    ...linkSection('Proposed rulings and resume doctrine notes', 'Standing rulings and the resume doctrine notes are on [docs/formats/rulings.md](formats/rulings.md).'),
    ...linkSection('Resume release notes', 'The `whatsNew` field and the per-checkout version record are on [docs/formats/resume-notes.md](formats/resume-notes.md).'),
    ...bare('SQLite board schema'),
    ...table('Format versions', 'format-versions'),
    ...table('Upgrade rules', 'upgrade-rules'),
    ...table('Board columns', 'board-columns'),
    ...table('Board indexes', 'board-indexes'),
    ...table('Board triggers', 'board-triggers'),
    ...table('Temp columns', 'temp-columns'),
    ...table('Temp triggers', 'temp-triggers'),
    ...bare('Local board identities and cross-board moves'),
    '## Event log',
    '',
    ...marked(blocks, 'events'),
    ...bare('Flow report and captured submission size'),
    ...bare('Submit test selection'),
    ...linkSection('Static view export', 'The exported files, the replay page and the landing, Rigor and release-receipt engine notes are on [docs/formats/static-view.md](formats/static-view.md).'),
    ...bare('Native proof provenance'),
    ...bare('Approval provenance'),
    ...bare('Offline flow replay'),
    ...linkSection('Recorded board line settings', 'The eight line settings and their ranges, the ordering and landing engine notes, outside intake and sandbox receipts, capacity decisions, item decision options and signed board membership are on [docs/formats/settings.md](formats/settings.md).'),
    ...bare('Seat addresses'),
    ...linkSection('Machine-local runner rate card', 'A runner\'s rate card (`runnerRates`, set with `pullboard settings runnerRates`) is described on [docs/formats/rate-card.md](formats/rate-card.md).'),
    ...bare('Machine-local relay canary'),
  ].join('\n').replace(/\n+$/u, '\n');
}

/** The engine page of the formats doc: headings held here, its table rendered from the event declarations [C7]. */
export function engineFirstPage(blocks) {
  return [
    '# Event log kinds',
    '',
    'Generated from `apps/cli/src/io/documentation/events` by `docs/formats/generate.mjs`; edit the declarations, then regenerate. The prose around this table stays in the Event log section of `docs/formats.md`.',
    '',
    '<!-- events:start -->',
    blocks.events.trimEnd(),
    '<!-- events:end -->',
    '',
  ].join('\n');
}

/** The static view page: headings held here, its snapshot table rendered from the declarations; its authored prose is dropped [C7]. */
export function staticViewPage(blocks) {
  return [
    '# Static view export',
    '',
    '## Snapshot files',
    '',
    '<!-- snapshot-files:start -->',
    blocks['snapshot-files'].trimEnd(),
    '<!-- snapshot-files:end -->',
    '',
  ].join('\n');
}

/** The spec page: headings held here, its four tables rendered from the parser declarations; its authored prose is dropped [C7]. */
export function specPage(blocks) {
  return [
    '# SPEC.md and DOCTRINE.md',
    '',
    '## SPEC.md and DOCTRINE.md',
    '',
    '<!-- id-pattern:start -->',
    blocks['id-pattern'].trimEnd(),
    '<!-- id-pattern:end -->',
    '',
    '<!-- statuses:start -->',
    blocks.statuses.trimEnd(),
    '<!-- statuses:end -->',
    '',
    '<!-- tiers:start -->',
    blocks.tiers.trimEnd(),
    '<!-- tiers:end -->',
    '',
    '### Parsed row fields',
    '',
    '<!-- parser-fields:start -->',
    blocks['parser-fields'].trimEnd(),
    '<!-- parser-fields:end -->',
    '',
  ].join('\n');
}

/** The API guide: headings held here, its three shape tables rendered from the JSON shape catalog, its v1 path table and the reference paragraphs its tests require held in api-notes.js; the other authored prose is dropped [C7,A1]. */
export function apiPage(blocks) {
  const notes = API_NOTES;
  return [
    '# CLI JSON API',
    '',
    notes.versioning,
    '',
    notes.decisions,
    '',
    notes.projectDecisions,
    '',
    '## Command result shapes',
    '',
    ...marked(blocks, 'api-command-shapes'),
    '## Refusals',
    '',
    ...marked(blocks, 'api-refusal-shapes'),
    '## Local HTTP API v1',
    '',
    notes.serve,
    '',
    notes.origin,
    '',
    '| Method and path | Result |',
    '| --- | --- |',
    ...HTTP_PATHS.map(([path, result]) => `| \`${path}\` | ${result} |`),
    '',
    notes.boards,
    '',
    notes.item,
    '',
    notes.proofs,
    '',
    notes.snapshots,
    '',
    '### Response shapes',
    '',
    ...marked(blocks, 'api-http-shapes'),
    notes.stream,
    '',
    notes.streams,
    '',
  ].join('\n');
}

/** Render every generated copy without touching a repository board or rewriting authored prose. */
export function generatedDocs(root = fileURLToPath(new URL('../../../../../', import.meta.url)), { openBoard } = {}) {
  const board = openBoard(':memory:');
  let blocks;
  try { blocks = { ...schemaDocBlocks(board.db), ...declarationDocBlocks(root), 'format-versions': formatTable(root) }; }
  finally { closeBoard(board); }
  const tables = {
    'api-command-shapes': shapeTable(['Command', 'Required top-level fields'], Object.fromEntries(
      Object.entries(JSON_SHAPES.commands).map(([name, shape]) => [name, shape.required]))),
    'api-refusal-shapes': shapeTable(['Part', 'Required fields'], { envelope: JSON_SHAPES.error.required, error: JSON_SHAPES.errorFields }),
    'api-http-shapes': shapeTable(['Response', 'Required top-level fields'], Object.fromEntries(
      Object.entries(JSON_SHAPES.http).map(([name, shape]) => [name, shape.required]))),
  };
  return new Map([
    ['docs/formats.md', formatsPage(blocks)], ['docs/formats/spec.md', specPage(blocks)], ['docs/formats/static-view.md', staticViewPage(blocks)], ['docs/api.md', apiPage({ ...blocks, ...tables })],
    ['docs/formats/engine-first.md', engineFirstPage(blocks)],
    ['apps/cli/src/logic/help/additions.js', commandHelpModule(root)],
  ]);
}

/** Report stale committed copies; a missing generated output is also drift. */
export function generatedDocDrift(root, outputs, ports) {
  if (outputs === undefined) outputs = generatedDocs(root, ports);
  return [...outputs].filter(([file, content]) => {
    try { return files.readFile(join(root, file), 'utf8') !== content; }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }).map(([file]) => file);
}

/** Refresh every changed copy and return exactly the paths landing must stage. */
export function writeGeneratedDocs(root, outputs, ports) {
  if (outputs === undefined) outputs = generatedDocs(root, ports);
  const changed = generatedDocDrift(root, outputs);
  for (const file of changed) files.writeFile(join(root, file), outputs.get(file));
  return changed;
}
