/** A claiming next writes the item folder's files with parallel checkout workers, unless the repository sets its own count [C7,#5776]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../tests/fixtures/next/take.js';
import { cli } from '../../tests/fixtures/next/take.js';

/** 150 tracked files, above Git's 100-file threshold for parallel checkout. */
const files = Object.fromEntries(Array.from({ length: 150 }, (_, n) => [`web/many/file-${n}.js`, `export const n = ${n};\n`]));

/** Run one claiming next with Git's trace2 events written to a file, and count the checkout workers Git started. */
async function tracedNext(t, box) {
  const trace = join(box.root, '..', 'trace2.json');
  const prior = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = trace;
  t.after(() => { if (prior === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = prior; });
  const result = await cli(box, box.seats.actor.path, ['next']);
  delete process.env.GIT_TRACE2_EVENT;
  assert.equal(result.code, 0, result.out + result.err);
  const workers = readFileSync(trace, 'utf8').split('\n').filter(line => line.includes('"child_start"') && line.includes('checkout--worker')).length;
  return { workers };
}

test('clause 1: a claiming next opens the item folder with parallel checkout workers and a complete clean tree [C7]', async t => {
  const box = await fixture(t, { files });
  const id = box.add('Parallel folder', { brief: 'Files: web/parallel.js\nTest: the folder opens fast.' });
  const { workers } = await tracedNext(t, box);
  assert.ok(workers > 0, 'the item folder was written by one sequential checkout');
  const folder = `${box.seats.actor.path}-item-${id}`;
  assert.equal(box.git(folder, 'status', '--porcelain', '--untracked-files=all').trim(), '');
  assert.equal(box.git(folder, 'ls-files', 'web/many').trim().split('\n').length, 150);
  assert.equal(readFileSync(join(folder, 'web/many/file-149.js'), 'utf8'), 'export const n = 149;\n');
});

test('clause 1: a repository that sets checkout.workers keeps its own count [C7]', async t => {
  const box = await fixture(t, { files });
  box.git(box.root, 'config', 'checkout.workers', '1');
  box.add('Sequential folder', { brief: 'Files: web/sequential.js\nTest: the folder keeps the configured count.' });
  const { workers } = await tracedNext(t, box);
  assert.equal(workers, 0);
});
