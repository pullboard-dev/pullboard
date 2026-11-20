/** @pullboard-test-input source-cell apps/cli spec */
/** @pullboard-test-input docs/formats/engine-first.md docs/formats/generate.mjs */
/** @pullboard-world-pin reads the committed engine page and the event declarations to prove the generator reproduces the page and a changed declaration fails the check. */
/** The first engine section of the formats doc is generated from the code's declarations and checked against the committed page [C7]. */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../packages/gate/tests/fixtures/child.js';
import { checkPages, renderPages, writePages } from './formats/generate.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PAGE = 'docs/formats/engine-first.md';
const DOCS = 'apps/cli/src/io/documentation';
const EVENTS = `${DOCS}/events`;

/** A scratch root holding the declarations and the committed page. */
function scratchRoot() {
  const root = privateFixtureFiles('formats-generate-').root;
  for (const path of [DOCS, PAGE]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(ROOT, path), join(root, path), { recursive: true });
  }
  return root;
}

test('clause 1: running the generator rewrites docs/formats/engine-first.md byte-identically to the committed page [C7]', () => {
  const root = scratchRoot();
  try {
    writeFileSync(join(root, PAGE), 'stale\n');
    writePages(root);
    assert.equal(readFileSync(join(root, PAGE), 'utf8'), readFileSync(join(ROOT, PAGE), 'utf8'));
    assert.equal(renderPages(ROOT)[PAGE], readFileSync(join(ROOT, PAGE), 'utf8'));
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
