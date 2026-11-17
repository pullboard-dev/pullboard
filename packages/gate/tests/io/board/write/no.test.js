/** @pullboard-test-loads apps/cli/tests/fixtures/e2e.js */
import assert from 'node:assert/strict';
import { renameSync } from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';

const candidateRoot = process.env.PULLBOARD_2835_CANDIDATE_ROOT ?? resolve(import.meta.dirname, '../../../../../..');
const { createE2eHelpers } = await import(pathToFileURL(join(candidateRoot, 'apps/cli/tests/fixtures/e2e.js')).href);
const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Move an initialized repository so coordinator reads must use the write-only identity repair. */
function relocate(box, source, name) {
  const destination = join(box.dir, name);
  renameSync(source, destination);
  return destination;
}

test('gate.io-board-write-no.status-completes-on-a-read-only: clause 1: status completes on a read-only board open without ReadNeedsWrite [C7]', async () => {
  const box = e2e.project(undefined, e2e.sandbox(), { withWorktree: false });
  const statusRoot = relocate(box, box.repo, 'status-root');
  const status = await box.runLocal(statusRoot, 'status', '--json');
  assert.equal(status.code, 0, `${status.out}\n${status.err}`);
  assert.doesNotMatch(`${status.out}\n${status.err}`, /ReadNeedsWrite/u);
});

test('gate.io-board-write-no.resume-diagnostics-recovers-coordinator-identity-through: clause 2: resume --diagnostics recovers coordinator identity through the writable fallback, not the read store [C7]', async () => {
  const box = e2e.project(undefined, e2e.sandbox(), { withWorktree: false });
  const resumeRoot = relocate(box, box.repo, 'resume-root');
  const resume = await box.runLocal(resumeRoot, 'resume', '--diagnostics', '--json');
  assert.equal(resume.code, 0, `${resume.out}\n${resume.err}`);
  assert.doesNotMatch(`${resume.out}\n${resume.err}`, /ReadNeedsWrite/u);
});
