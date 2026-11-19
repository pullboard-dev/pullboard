/** @pullboard-test-input apps/cli/src/io/generated/docs.js apps/cli/src/io/documentation/events/*.json docs/formats/engine-first.md docs/tools/update-docs.js */
/** The generated-docs boundary renders the engine page whole from the declarations, with no committed page to read [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../../../../lib/index.js';
import { docsRepository } from '../../fixtures/generated/docs.js';
import { generatedDocs } from '../../../src/io/generated/docs.js';

const PAGE = 'docs/formats/engine-first.md';

test('cli.io-generated-docs.engine-page-whole: clause 1: generatedDocs returns docs/formats/engine-first.md rendered whole on a root that has no such file [C7]', (t) => {
  const box = docsRepository(t);
  const committed = readFileSync(join(box.root, PAGE), 'utf8');
  rmSync(join(box.root, PAGE));
  assert.equal(existsSync(join(box.root, PAGE)), false);
  const page = generatedDocs(box.root, { openBoard }).get(PAGE);
  assert.equal(page, committed, 'the rendered page equals the committed copy');
  assert.match(page, /^# Event log kinds\n/u);
  assert.match(page, /<!-- events:start -->\n\| Kind \| Actor \| Detail fields \|/u);
  assert.ok(page.endsWith('<!-- events:end -->\n'));
});

test('cli.io-generated-docs.engine-page-written: clause 2: docs/tools/update-docs.js writes the whole page where none exists and --check then passes [C7]', (t) => {
  const box = docsRepository(t);
  const committed = readFileSync(join(box.root, PAGE), 'utf8');
  rmSync(join(box.root, PAGE));
  const written = box.node('docs/tools/update-docs.js');
  assert.equal(written.status, 0, written.context);
  assert.equal(readFileSync(join(box.root, PAGE), 'utf8'), committed);
  const checked = box.node('docs/tools/update-docs.js', '--check');
  assert.equal(checked.status, 0, checked.context);
});
