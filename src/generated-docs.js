/** One generation boundary for source-owned format, API, help and lifecycle declarations [C7,A1,A5,M1]. */
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBoard } from './board.js';
import { closeBoard } from './board.js';
import { JSON_SHAPES } from './json.js';
import { lifecycleMarkdown } from './machine.js';
import { formatTable } from './format-registry.js';
import { HELP_SECTIONS } from './help/sections.js';
import { commandHelpModule } from './command-docs.js';
import { commandHelpText } from './command-docs.js';
import { replaceDocTable } from './generated-doc-blocks.js';
import { shapeTable } from './generated-doc-blocks.js';
import { schemaDocBlocks } from './generated-doc-schema.js';
import { declarationDocBlocks } from './generated-doc-declarations.js';

/** Render every generated copy without touching a repository board or rewriting authored prose. */
export function generatedDocs(root = fileURLToPath(new URL('../', import.meta.url))) {
  const board = openBoard(':memory:');
  let blocks;
  try { blocks = { ...schemaDocBlocks(board.db), ...declarationDocBlocks(root), 'format-versions': formatTable(root) }; }
  finally { closeBoard(board); }
  let formats = readFileSync(join(root, 'docs', 'formats.md'), 'utf8');
  for (const [name, table] of Object.entries(blocks)) formats = replaceDocTable(formats, name, table);
  let api = readFileSync(join(root, 'docs', 'api.md'), 'utf8');
  const tables = {
    'api-command-shapes': shapeTable(['Command', 'Required top-level fields'], Object.fromEntries(
      Object.entries(JSON_SHAPES.commands).map(([name, shape]) => [name, shape.required]))),
    'api-refusal-shapes': shapeTable(['Part', 'Required fields'], { envelope: JSON_SHAPES.error.required, error: JSON_SHAPES.errorFields }),
    'api-http-shapes': shapeTable(['Response', 'Required top-level fields'], Object.fromEntries(
      Object.entries(JSON_SHAPES.http).map(([name, shape]) => [name, shape.required]))),
  };
  for (const [name, table] of Object.entries(tables)) api = replaceDocTable(api, name, table);
  const help = HELP_SECTIONS.map(section => section.name === 'additions' ? commandHelpText(root) : section.text).join('');
  return new Map([
    ['docs/formats.md', formats], ['docs/api.md', api], ['docs/lifecycle.md', lifecycleMarkdown()],
    ['src/help/additions.js', commandHelpModule(root)], ['docs/cli-help.txt', help + '\n'],
  ]);
}

/** Report stale committed copies; a missing generated output is also drift. */
export function generatedDocDrift(root, outputs = generatedDocs(root)) {
  return [...outputs].filter(([file, content]) => {
    try { return readFileSync(join(root, file), 'utf8') !== content; }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }).map(([file]) => file);
}

/** Refresh every changed copy and return exactly the paths landing must stage. */
export function writeGeneratedDocs(root, outputs = generatedDocs(root)) {
  const changed = generatedDocDrift(root, outputs);
  for (const file of changed) writeFileSync(join(root, file), outputs.get(file));
  return changed;
}
