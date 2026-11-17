/** One generation boundary for source-owned format, API, and help declarations [C7,A1,A5,M1]. */
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../../../../../packages/git/index.js';
import { fileURLToPath } from 'node:url';
import { closeBoard } from '../../../../../packages/store/index.js';
import { JSON_SHAPES } from '../../../../../packages/config/index.js';
import { formatTable } from '../../../../../packages/state/index.js';
import { commandHelpModule } from '../docs.js';
import { replaceDocTable } from '../../logic/generated/doc/blocks.js';
import { shapeTable } from '../../logic/generated/doc/blocks.js';
import { schemaDocBlocks } from '../../logic/generated/doc/schema.js';
import { declarationDocBlocks } from './declarations.js';

/** Render every generated copy without touching a repository board or rewriting authored prose. */
export function generatedDocs(root = fileURLToPath(new URL('../../../../../', import.meta.url)), { openBoard } = {}) {
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
  return new Map([
    ['docs/formats.md', formats], ['docs/api.md', api],
    ['apps/cli/src/logic/help/additions.js', commandHelpModule(root)],
  ]);
}

/** Report stale committed copies; a missing generated output is also drift. */
export function generatedDocDrift(root, outputs, ports) {
  if (outputs === undefined) outputs = generatedDocs(root, ports);
  return [...outputs].filter(([file, content]) => {
    try { return readFileSync(join(root, file), 'utf8') !== content; }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }).map(([file]) => file);
}

/** Refresh every changed copy and return exactly the paths landing must stage. */
export function writeGeneratedDocs(root, outputs, ports) {
  if (outputs === undefined) outputs = generatedDocs(root, ports);
  const changed = generatedDocDrift(root, outputs);
  for (const file of changed) writeFileSync(join(root, file), outputs.get(file));
  return changed;
}

/** The staged paths whose content feeds a generated copy: command, format and event declarations, the store schema and the settings of the tools. */
const DECLARATION_SOURCE = /^(?:apps\/cli\/src\/io\/(?:command-docs|documentation)\/|packages\/[^/]+\/src\/io\/(?:formats|schema)\/|packages\/(?:store|config|state)\/)/u;

/**
 * Regenerate and stage the generated documentation copies when a commit changes the declarations they are built from (#9664).
 * Why: the hand lander skips the landing batch that regenerates them, so drift reached main twice in one day. A copy the
 * person has partly staged is left alone and named, so no unstaged hunk is staged.
 *
 * @param {string} root the committing checkout
 * @param {{ openBoard: Function }} ports
 * @returns {string[]} notes for the person committing
 */
export function regenerateStagedDocs(root, ports) {
  const staged = git(root, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
  if (!staged.some(path => DECLARATION_SOURCE.test(path))) return [];
  const changed = generatedDocDrift(root, undefined, ports);
  if (!changed.length) return [];
  const unstaged = new Set(git(root, ['diff', '--name-only', '-z']).split('\0').filter(Boolean));
  const partly = changed.filter(file => unstaged.has(file));
  const outputs = generatedDocs(root, ports);
  const fixable = changed.filter(file => !unstaged.has(file));
  for (const file of fixable) writeFileSync(join(root, file), outputs.get(file));
  if (fixable.length) git(root, ['add', '--', ...fixable]);
  return [
    ...(fixable.length ? [`regenerated ${fixable.join(', ')} and staged them`] : []),
    ...(partly.length ? [`not regenerated, because they are partly staged: ${partly.join(', ')}`] : []),
  ];
}
