/** A runner job's log and artifacts are readable from the board after the runner's folder is deleted [P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { jobView } from '../../../jobs/index.js';
import { jobQueueCall } from '../../index.js';
import { jobArtifacts } from '../../index.js';
import { offerJob } from '../../index.js';

const refusal = call => { try { call(); } catch (error) { return error.code; } return null; };

test('clause 1: a log and a binary artifact posted by the runner outlive its deleted folder, and only the holder may post [P7]', t => {
  const { root } = privateFixtureFiles('pullboard-jobs-artifacts-');
  const db = cellBoard(t, join(root, 'board.sqlite')).db;
  const call = body => jobQueueCall(db, body, { mode: 'pull' });
  offerJob(db, { id: 'gate:artifacts', kind: 'gate', needs: ['node22'] });
  const { claim } = call({ action: 'claim', runner: 'r-holder', capabilities: ['node22'] });
  const held = { job: 'gate:artifacts', runner: 'r-holder', token: claim.token };

  const folder = join(root, 'runner-folder');
  mkdirSync(folder);
  const log = 'ok 1 - a\nnot ok 2 - b\n'.repeat(20_000); // past the inline threshold, so it rides the blob store
  writeFileSync(join(folder, 'output.log'), log);
  writeFileSync(join(folder, 'profile.bin'), Buffer.from([0, 1, 2, 255]));

  assert.equal(refusal(() => call({ action: 'artifact', job: 'gate:artifacts', runner: 'r-other', token: claim.token, artifact: { name: 'output.log', body: 'x' } })), 'JOB_LEASE_MOVED', 'another runner is refused');
  assert.equal(refusal(() => call({ action: 'artifact', ...held, artifact: { name: '../escape', body: 'x' } })), 'JOB_ARTIFACT', 'a path is no name');
  assert.equal(refusal(() => call({ action: 'artifact', ...held, artifact: { name: 'big.log', body: 'x'.repeat(8 * 1024 ** 2 + 1) } })), 'JOB_ARTIFACT', 'a body past the cap is refused');
  assert.equal(jobArtifacts(db, 'gate:artifacts').size, 0, 'no refused post was kept');

  const posted = call({ action: 'artifact', ...held, artifact: { name: 'output.log', body: readFileSync(join(folder, 'output.log'), 'utf8') } });
  assert.deepEqual([posted.name, posted.bytes, posted.recorded], ['output.log', Buffer.byteLength(log), true]);
  call({ action: 'artifact', ...held, artifact: { name: 'profile.bin', encoding: 'base64', body: readFileSync(join(folder, 'profile.bin')).toString('base64') } });
  assert.equal(jobView(db, 'gate:artifacts').step, 'claimed', 'posting an artifact never moves the job');

  rmSync(folder, { recursive: true, force: true });
  assert.equal(existsSync(folder), false, 'the runner folder is gone');
  const kept = jobArtifacts(db, 'gate:artifacts');
  assert.equal(kept.get('output.log').toString('utf8'), log, 'the board reads the whole log back');
  assert.deepEqual([...kept.get('profile.bin')], [0, 1, 2, 255], 'the board reads the binary artifact back');

  call({ action: 'artifact', ...held, artifact: { name: 'output.log', body: 'short' } });
  assert.equal(jobArtifacts(db, 'gate:artifacts').get('output.log').toString('utf8'), 'short', 'a repost of the same name replaces it');
});
