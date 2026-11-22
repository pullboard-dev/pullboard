/** @pullboard-test-input source-cell apps/cli spec */
/** @pullboard-test-input docs/formats/generate.mjs */
/** @pullboard-world-pin reads the event declarations and the engine page from generatedDocs to prove the generator reproduces the page and a changed declaration fails the check. */
/** The first engine section of the formats doc is generated from the code's declarations and checked against the committed page [C7]. */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../packages/board/index.js';
import { generatedDocs } from '../apps/cli/src/io/generated/docs.js';
import { privateFixtureFiles } from '../packages/gate/tests/fixtures/child.js';
import { checkPages, renderPages, writePages } from './formats/generate.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PAGE = 'docs/formats/engine-first.md';
const DOCS = 'apps/cli/src/io/documentation';
const EVENTS = `${DOCS}/events`;
/** The engine page as generatedDocs renders it; no committed copy is read. */
const RENDERED = generatedDocs(ROOT, { openBoard }).get(PAGE);

/** A scratch root holding the declarations and the rendered page. */
function scratchRoot() {
  const root = privateFixtureFiles('formats-generate-').root;
  mkdirSync(dirname(join(root, DOCS)), { recursive: true });
  cpSync(join(ROOT, DOCS), join(root, DOCS), { recursive: true });
  mkdirSync(dirname(join(root, PAGE)), { recursive: true });
  writeFileSync(join(root, PAGE), RENDERED);
  return root;
}

test('clause 1: running the generator rewrites docs/formats/engine-first.md byte-identically to the committed page [C7]', () => {
  const root = scratchRoot();
  try {
    writeFileSync(join(root, PAGE), 'stale\n');
    writePages(root);
    assert.equal(readFileSync(join(root, PAGE), 'utf8'), RENDERED);
    assert.equal(renderPages(ROOT)[PAGE], RENDERED);
    checkPages(ROOT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clause 1: a changed declaration makes the check fail naming the page [C7]', () => {
  const root = scratchRoot();
  try {
    checkPages(root);
    const file = join(root, EVENTS, 'accept.json');
    const row = JSON.parse(readFileSync(file, 'utf8'));
    row.entries[0].detail += ', `changedForCheck`';
    writeFileSync(file, JSON.stringify(row, null, 2));
    assert.throws(() => checkPages(root), (error) => error.message.includes(PAGE));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
