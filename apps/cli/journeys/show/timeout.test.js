/** @pullboard-test-input apps/cli/index.js apps/cli/pullboard.js apps/cli/tests/fixtures/board.js packages/api/index.js packages/seats/index.js */
/** Unreachable registered repositories cannot retain project listing or an actual verdict command [C7,N33]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import { projectGitTimeoutFixture } from '../../tests/fixtures/timeout.js';

test('the registered project list bounds stalled Git, names its root and retains readable projects [C7,N33]', { timeout: 120_000 }, async t => { // budget: native fixture setup plus one five-second Git deadline and a bounded diagnostic child.
  const box = projectGitTimeoutFixture(t);
  const url = file => pathToFileURL(join(import.meta.dirname, '../../../..', file)).href;
  const script = `import {apiBoardListing} from ${JSON.stringify(url('packages/api/index.js'))};
import {listApiProjects} from ${JSON.stringify(url('packages/seats/index.js'))};
import {apiBoardOpeners} from ${JSON.stringify(url('apps/cli/tests/fixtures/board.js'))};
import {refusalDocument} from ${JSON.stringify(url('apps/cli/index.js'))};
console.log(JSON.stringify(apiBoardListing(listApiProjects,undefined,refusalDocument,apiBoardOpeners)));`;
  const child = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', script], // budget: absence of the production Git deadline must fail instead of retaining the test indefinitely.
    { cwd: box.repo, env: box.env, timeout: 45_000, killSignal: 'SIGKILL' });
  assert.equal(child.status, 0, child.context + child.stdout);
  assert.equal(existsSync(box.marker), true, 'the real Git stand-in was reached');
  const listed = JSON.parse(child.stdout);
  assert.ok(listed.boards.some(project => project.root === box.repo));
  assert.equal(listed.boards.some(project => project.root === box.bad), false);
  const warning = listed.warnings.find(project => project.root === box.bad);
  assert.match(warning?.error.error.message ?? '', /unreachable.*timed out/u);
  assert.ok(warning.error.error.message.includes(box.bad));
});

test('verify skips a registered repository whose Git never returns and still records the verdict [C7,N33]', { timeout: 120_000 }, async t => { // budget: real add/build/submit/reviewer setup plus one bounded foreign Git lookup.
  const box = projectGitTimeoutFixture(t, { review: true });
  const child = await runFixtureChildAsync(process.execPath, [join(import.meta.dirname, '../../pullboard.js'), 'verify', String(box.item), 'accept',
    '--note', 'The frozen ready file exists.', '--no-next', '--json'], // budget: a regression in the foreign-project lookup fails at the outer diagnostic ceiling.
  { cwd: box.reviewer, env: box.env, timeout: 45_000, killSignal: 'SIGKILL' });
  assert.equal(child.status, 0, child.context + child.stdout);
  assert.equal(existsSync(box.marker), true, 'verify used the registered-project fallback');
  assert.match(child.stderr, /unreachable.*timed out/u);
  assert.ok(child.stderr.includes(box.bad));
  const after = (await box.runLocal(box.repo, 'show', String(box.item), '--json'));
  assert.equal(after.code, 0, after.out + after.err);
  assert.equal(JSON.parse(after.out).item_status, 'verified');
});
