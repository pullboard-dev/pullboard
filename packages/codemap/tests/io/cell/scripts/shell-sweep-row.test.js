/** @pullboard-test-input source-cell codemap cli */
/** @pullboard-world-pin reads the committed cells plan row, the cli sources and the front door to prove the sweep.js move. */
/** The cli sweep.js core row sits in the shell cell, with its importers repointed [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const PLAN = new URL('../../../../data/plan/', import.meta.url);
const CLI = new URL('../../../../../../apps/cli/', import.meta.url);
const OLD = 'apps/cli/src/logic/sweep.js';
const NEW = 'apps/cli/src/io/sweep/problems.js';

test('clause 1: the cli sweep.js row sits in the shell cell in the cells plan with importers repointed [C7]', () => {
  const rows = JSON.parse(readFileSync(new URL('49-app-cli.json', PLAN), 'utf8')).paths;
  const row = rows.find(([from]) => from === 'src/sweep.js');
  assert.equal(row[1], NEW);
  assert.ok(!rows.some(([, to]) => to === OLD));
  // The shell cell already owns apps/cli/src/io/sweep.js, so the moved row takes a distinct name beside it.
  assert.equal(rows.filter(([, to]) => to === NEW).length, 1);
  assert.ok(rows.some(([, to]) => to === 'apps/cli/src/io/sweep.js'));
  const pathMap = JSON.parse(readFileSync(new URL('path-map/cli.json', PLAN), 'utf8'));
  assert.equal(pathMap['src/sweep.js'], NEW);
  const renames = readFileSync(new URL('renames.tsv', PLAN), 'utf8');
  assert.ok(renames.includes(`apps/cli/src/core/sweep.js\t${NEW}\n`));
  assert.ok(!renames.includes(OLD));
  assert.ok(existsSync(new URL('src/io/sweep/problems.js', CLI)));
  assert.ok(!existsSync(new URL('src/logic/sweep.js', CLI)));
  assert.match(readFileSync(new URL('src/io/sweep.js', CLI), 'utf8'), /from '\.\/sweep\/problems\.js'/u);
  assert.match(readFileSync(new URL('index.js', CLI), 'utf8'), /from "\.\/src\/io\/sweep\/problems\.js"/u);
});
