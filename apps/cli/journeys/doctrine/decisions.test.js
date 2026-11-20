/** A person decides a standard doctrine default with spec approve and spec decline, and the coordinator applies it [C7,#2007]. */
/** @pullboard-test-input source-cell apps/cli apps/lib store */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const fixtures = createE2eHelpers();
after(fixtures.cleanup);

/** Require a successful real command and retain its diagnostics on failure. */
function succeeds(result) {
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  return result;
}

/** The doctrine rows the real spec command reports, inherited standard defaults among them. */
async function doctrineRows(box) {
  return JSON.parse(succeeds(await box.runIn(box.repo, 'spec', '--json')).out).rows.filter(row => row.id.startsWith('PB'));
}

test('cli.doctrine-decisions.approve-standard-default: clause 1: spec approve doctrine:<standard id> applies as an approved row and the To review count falls by one [C7,#2007]', { timeout: 180_000 }, async () => {
  const box = fixtures.project('true');
  const before = await doctrineRows(box);
  const standard = before.filter(row => row.origin === 'standard');
  assert.ok(standard.length >= 2, 'the packaged standard has default rows to decide');
  const target = standard[0];
  succeeds(await box.runIn(box.repo, 'spec', 'approve', `doctrine:${target.id}`));
  succeeds(await box.runIn(box.repo, 'spec', 'apply'));
  assert.match(readFileSync(join(box.repo, 'DOCTRINE.md'), 'utf8'), new RegExp(`^- ${target.id} \\[approved`, 'mu'), 'the decision line is appended to the repo doctrine');
  const after = await doctrineRows(box);
  assert.equal(after.find(row => row.id === target.id).status, 'approved');
  assert.equal(after.filter(row => row.origin === 'standard').length, standard.length - 1, 'the To review count falls by one');
});

test('cli.doctrine-decisions.decline-standard-default: clause 2: spec decline doctrine:<standard id> --reason writes its wont line into DOCTRINE.md on apply [C7,#2007]', { timeout: 180_000 }, async () => {
  const box = fixtures.project('true');
  const standard = (await doctrineRows(box)).filter(row => row.origin === 'standard');
  const target = standard[1];
  succeeds(await box.runIn(box.repo, 'spec', 'decline', `doctrine:${target.id}`, '--reason', 'we deploy by hand'));
  succeeds(await box.runIn(box.repo, 'spec', 'apply'));
  assert.match(readFileSync(join(box.repo, 'DOCTRINE.md'), 'utf8'), new RegExp(`^- ${target.id} \\[wont\\] we deploy by hand$`, 'mu'));
});
