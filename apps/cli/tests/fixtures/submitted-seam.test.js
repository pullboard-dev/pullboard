/** @pullboard-test-input source-cell apps/cli */
/** submittedWithoutGate drives the board submit move over a hand-written pass receipt and leaves the claimed item submitted at its committed head, with no runner gate job [C7,#9873]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { onBoard } from './land/board.js';
import { fileFixtureItem } from './testkit.js';
import { createE2eHelpers } from './e2e.js';
import {
  gateJobCount,
  submittedWithoutGate,
} from './submitted-seam.js';
import { clean } from './verdict-check.js';
import { project } from './verdict-check.js';
import { sandbox } from './verdict-check.js';
import { submitted } from './verdict-check.js';
import { succeeds } from './verdict-check.js';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A claimed item with one committed change in its seat. */
async function claimedItem(box) {
  const item = await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Seam submit', run: box.runLocal });
  const claim = await box.runLocal(box.web, 'claim', String(item.item_id));
  assert.equal(claim.code, 0, claim.out + claim.err);
  const commit = e2e.commitFile(box, box.web, 'web/seam.js', 'export const seam = 1;\n', 'feat(web): seam change [G1]');
  assert.equal(commit.status, 0, commit.stderr);
  return item.item_id;
}

test('cli.tests-fixtures-submitted-seam.submitted-at-the-committed-head: clause 1: submittedWithoutGate(box, cwd, id) drives the board submit move with that receipt and leaves the claimed item submitted at its committed head, readable by pullboard show [C7,#9873]', async () => {
  const box = e2e.project();
  const id = await claimedItem(box);
  const receiptId = submittedWithoutGate(box, box.web, id);
  const head = box.git(box.web, 'rev-parse', 'HEAD').trim();
  const item = onBoard(box, board => store.getItem(board, id));
  assert.equal(item.item_status, 'submitted', 'the board holds the item submitted');
  assert.ok(onBoard(box, board => store.proofReceipts(board, id)).some(row => row.id === receiptId), 'the receipt it submitted over is on the item');
  const shown = await box.runLocal(box.web, 'show', String(id), '--json');
  assert.equal(shown.code, 0, shown.out + shown.err);
  assert.match(shown.out, new RegExp(head), 'pullboard show names the committed head');
});

test('cli.tests-fixtures-submitted-seam.no-runner-gate-job: clause 2: the same submit leaves no runner gate job for the item [C7,#9873]', async () => {
  const box = e2e.project();
  const id = await claimedItem(box);
  submittedWithoutGate(box, box.web, id);
  assert.equal(gateJobCount(box, id), 0, 'no runner gate job exists');
});

/** The accept an item holds, as a verify would leave it, without ids, times or commits: the verdict row and the accept event's fields. */
async function acceptRecord(box, repo, id) {
  const shown = JSON.parse(await succeeds(box, repo, 'show', String(id), '--json'));
  const event = JSON.parse(await succeeds(box, repo, 'log', String(id), '--json')).events.find(row => row.event_kind === 'accept');
  const verdict = shown.verdicts.at(-1);
  const strip = value => Object.fromEntries(Object.entries(value).filter(([key]) => !/^(id|at|commit|head|digest|time|created|receipt|tree)/iu.test(key)).sort(([a], [b]) => a.localeCompare(b)));
  return { status: shown.status ?? shown.item?.item_status ?? null, verdict: strip(verdict), detail: strip(JSON.parse(event.event_detail)), detailKeys: Object.keys(JSON.parse(event.event_detail)).sort() };
}

test('cli.tests-fixtures-submitted-seam.verify-accept-after-the-seam: clause 1: verify accept on the seam-submitted item succeeds and the item reads verified; clause 2: its accept record equals the one an item submitted through a pulled gate leaves [C7,#9874]', async () => {
  const box = sandbox();
  try {
    const { repo, web } = await project(box);
    const real = await submitted(box, repo, web, 'Accept after a pulled gate');
    await succeeds(box, repo, 'verify', String(real.id), 'accept', '--as', 'coordinator', '--note', 'checked the submitted work');
    const realRecord = await acceptRecord(box, repo, real.id);
    box.git(repo, 'switch', 'main');

    const added = await succeeds(box, repo, 'add', 'web', 'Accept after the seam', '--specs', 'G1', '--criterion', 'The fixture item is complete.', '--route', 'strong', '--brief', 'Files: web/fixture.txt\nTest: the fixture item is accepted with its recorded check');
    const id = Number(/#(\d+)/.exec(added)?.[1]);
    await succeeds(box, web, 'claim', String(id));
    mkdirSync(join(web, 'web'), { recursive: true });
    writeFileSync(join(web, 'web', `item-${id}.js`), 'export const complete = true;\n');
    box.git(web, 'add', '-A');
    box.git(web, 'commit', '-q', '-m', `feat(web): complete fixture ${id} [G1]`);
    submittedWithoutGate({ repo, git: box.git }, web, id);
    box.git(repo, 'switch', '--detach', 'web/one');
    const seamAccept = await succeeds(box, repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'checked the submitted work');
    const seamRecord = await acceptRecord(box, repo, id);

    assert.match(seamAccept, /accept|verified|criterion/iu, 'the accept on the seam-submitted item succeeds');
    assert.match(await succeeds(box, repo, 'show', String(id)), /verified/u, 'the item reads verified');
    assert.deepEqual(seamRecord, realRecord, 'the accept record is the one a pulled gate leaves');
  } finally { clean(box); }
});
