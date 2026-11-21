/** @pullboard-test-input apps/cli/src/io/generated/docs.js apps/cli/src/io/documentation/events/*.json docs/formats/engine-first.md docs/formats/static-view.md docs/formats/spec.md docs/formats.md docs/tools/update-docs.js */
/** The generated-docs boundary renders the engine page whole from the declarations, with no committed page to read [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../../../../../packages/board/index.js';
import { docsRepository } from '../../fixtures/generated/docs.js';
import { generatedDocs } from '../../../src/io/generated/docs.js';

const PAGE = 'docs/formats/engine-first.md';
const STATIC_VIEW = 'docs/formats/static-view.md';
const SPEC = 'docs/formats/spec.md';
const FORMATS = 'docs/formats.md';

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

test('cli.io-generated-docs.static-view-renders-whole: clause 1: generatedDocs returns docs/formats/static-view.md rendered whole on a root that has no such file [C7]', (t) => {
  const box = docsRepository(t);
  const committed = readFileSync(join(box.root, STATIC_VIEW), 'utf8');
  rmSync(join(box.root, STATIC_VIEW));
  assert.equal(existsSync(join(box.root, STATIC_VIEW)), false);
  const page = generatedDocs(box.root, { openBoard }).get(STATIC_VIEW);
  assert.equal(page, committed, 'the rendered page equals the committed copy');
  assert.match(page, /^# Static view export\n\n## Snapshot files\n\n<!-- snapshot-files:start -->\n\| File below `DIR` \| Contents and reader \|/u);
  assert.ok(page.endsWith('<!-- snapshot-files:end -->\n'));
});

test('cli.io-generated-docs.static-view-written: clause 2: docs/tools/update-docs.js writes the whole static view page where none exists and --check then passes [C7]', (t) => {
  const box = docsRepository(t);
  const committed = readFileSync(join(box.root, STATIC_VIEW), 'utf8');
  rmSync(join(box.root, STATIC_VIEW));
  const written = box.node('docs/tools/update-docs.js');
  assert.equal(written.status, 0, written.context);
  assert.equal(readFileSync(join(box.root, STATIC_VIEW), 'utf8'), committed);
  const checked = box.node('docs/tools/update-docs.js', '--check');
  assert.equal(checked.status, 0, checked.context);
});

test('cli.io-generated-docs.spec-renders-whole: clause 1: generatedDocs returns docs/formats/spec.md rendered whole, with every generated table, on a root that has no such file [C7]', (t) => {
  const box = docsRepository(t);
  const committed = readFileSync(join(box.root, SPEC), 'utf8');
  rmSync(join(box.root, SPEC));
  assert.equal(existsSync(join(box.root, SPEC)), false);
  const page = generatedDocs(box.root, { openBoard }).get(SPEC);
  assert.equal(page, committed, 'the rendered page equals the committed copy');
  assert.match(page, /^# SPEC\.md and DOCTRINE\.md\n\n## SPEC\.md and DOCTRINE\.md\n\n<!-- id-pattern:start -->\n/u);
  for (const name of ['id-pattern', 'statuses', 'tiers', 'parser-fields']) {
    assert.ok(page.includes(`<!-- ${name}:start -->\n| `), `${name} table present`);
    assert.ok(page.includes(`\n<!-- ${name}:end -->\n`), `${name} end marker present`);
  }
  assert.ok(page.endsWith('<!-- parser-fields:end -->\n'));
});

test('cli.io-generated-docs.spec-written: clause 2: docs/tools/update-docs.js writes the whole spec page where none exists and --check then passes [C7]', (t) => {
  const box = docsRepository(t);
  const committed = readFileSync(join(box.root, SPEC), 'utf8');
  rmSync(join(box.root, SPEC));
  const written = box.node('docs/tools/update-docs.js');
  assert.equal(written.status, 0, written.context);
  assert.equal(readFileSync(join(box.root, SPEC), 'utf8'), committed);
  const checked = box.node('docs/tools/update-docs.js', '--check');
  assert.equal(checked.status, 0, checked.context);
});

test('cli.io-generated-docs.formats-renders-whole: clause 1: generatedDocs returns docs/formats.md rendered whole, with every generated table and each page link, on a root that has no such file [C7]', (t) => {
  const box = docsRepository(t);
  const committed = readFileSync(join(box.root, FORMATS), 'utf8');
  rmSync(join(box.root, FORMATS));
  assert.equal(existsSync(join(box.root, FORMATS)), false);
  const page = generatedDocs(box.root, { openBoard }).get(FORMATS);
  assert.equal(page, committed, 'the rendered page equals the committed copy');
  assert.match(page, /^# File formats\n/u);
  for (const name of ['format-versions', 'upgrade-rules', 'board-columns', 'board-indexes', 'board-triggers', 'temp-columns', 'temp-triggers', 'events']) {
    assert.ok(page.includes(`<!-- ${name}:start -->\n| `), `${name} table present`);
    assert.ok(page.includes(`\n<!-- ${name}:end -->\n`), `${name} end marker present`);
  }
  for (const [title, link] of [['Static view export', 'static-view'], ['SPEC.md and DOCTRINE.md', 'spec'], ['Recorded board line settings', 'settings']]) {
    assert.match(page, new RegExp(`## ${title.replaceAll('.', '\\.')}\\n\\n[^\\n]*\\]\\(formats/${link}\\.md\\)`, 'u'), `${title} keeps its page link`);
  }
  assert.ok(!page.includes('snapshot-files:start'), 'the static view table stays on its own page');
});

test('cli.io-generated-docs.formats-written: clause 2: docs/tools/update-docs.js writes the whole formats guide where none exists and --check then passes [C7]', (t) => {
  const box = docsRepository(t);
  const committed = readFileSync(join(box.root, FORMATS), 'utf8');
  rmSync(join(box.root, FORMATS));
  const written = box.node('docs/tools/update-docs.js');
  assert.equal(written.status, 0, written.context);
  assert.equal(readFileSync(join(box.root, FORMATS), 'utf8'), committed);
  const checked = box.node('docs/tools/update-docs.js', '--check');
  assert.equal(checked.status, 0, checked.context);
});
