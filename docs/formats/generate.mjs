/** Generate the engine pages of the formats doc from the code's declarations, and check the committed pages match [C7]. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { declarationDocBlocks } from '../../apps/cli/src/io/generated/declarations.js';

const HERE = resolve(import.meta.dirname, '..', '..');

/** Engine pages by path, each rendered from the declaration blocks of one root. First section: the event log kinds. */
export const ENGINE_PAGES = {
  'docs/formats/engine-first.md': (blocks) => [
    '# Event log kinds',
    '',
    'Generated from `apps/cli/src/io/documentation/events` by `docs/formats/generate.mjs`; edit the declarations, then regenerate. The prose around this table stays in the Event log section of `docs/formats.md`.',
    '',
    '<!-- events:start -->',
    blocks.events.trimEnd(),
    '<!-- events:end -->',
    '',
  ].join('\n'),
};

/** Render every engine page from the declarations under `root`. */
export function renderPages(root = HERE) {
  const blocks = declarationDocBlocks(root);
  return Object.fromEntries(Object.entries(ENGINE_PAGES).map(([path, render]) => [path, render(blocks)]));
}

/** Write each engine page; the committed page then equals a fresh render. */
export function writePages(root = HERE) {
  for (const [path, text] of Object.entries(renderPages(root))) writeFileSync(join(root, path), text);
}

/** Page paths whose committed text differs from a fresh render. */
export function stalePages(root = HERE) {
  return Object.entries(renderPages(root)).filter(([path, text]) => readFileSync(join(root, path), 'utf8') !== text).map(([path]) => path);
}

/** Check mode: refuse naming each stale page, so a changed declaration fails until the page is regenerated. */
export function checkPages(root = HERE) {
  const stale = stalePages(root);
  if (stale.length) throw new Error(`generated page out of date: ${stale.join(', ')}; run node docs/formats/generate.mjs`);
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv.includes('--check')) checkPages();
  else writePages();
}
