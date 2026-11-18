/** @pullboard-test-loads apps/cli/src/io/commands/handoff.js apps/cli/src/io/worktree/maintenance/command.js packages/state/index.js */
/** Private CLI lifecycle cases for completed seat takeover (handoff cleanup), split from lifecycle.js so each file fits its budget [B3,C7,N26]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { workingDirectories } from '../../../../../../../packages/landing/index.js';
import { startFixtureChild } from '../../../child.js';
import { createE2eHelpers } from '../../../e2e.js';
import { addFixtureItem } from '../lifecycle.js';
import { archiveFor } from '../lifecycle.js';
import { assertArchivedBytes } from '../lifecycle.js';
import { enable } from '../lifecycle.js';
import { handoffTakenAt } from '../lifecycle.js';
import { joinAgent } from '../lifecycle.js';
import { retainFixtureTimer } from '../lifecycle.js';

/** Register the handoff lifecycle checks; importing this fixture does not run them. */
export function registerMaintenanceCliHandoffTests() {
  test('completed handoff cleans the outgoing checkout only after a clear native cwd census [B3,C7,N26]', async t => {
    const helpers = createE2eHelpers(); t.after(helpers.cleanup);
    const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }), { withWorktree: false });
    await enable(box);
    const common = retainFixtureTimer(box), outgoing = join(box.dir, 'handoff-outgoing'), incoming = join(box.dir, 'handoff-incoming');
    const outgoingId = await joinAgent(box, outgoing), incomingId = await joinAgent(box, incoming);
    const bytes = Buffer.from([0, 21, 22, 255]);
    fs.writeFileSync(join(outgoing, 'unfinished.bin'), bytes);
    const opened = await box.runIn(outgoing, 'handoff', '--json');
    assert.equal(opened.code, 0, opened.err);
    const handoffItem = JSON.parse(opened.out).handoff.item;
    const taken = await box.runIn(incoming, 'handoff', '--take', String(handoffItem), '--json');
    assert.equal(taken.code, 0, taken.err);
    const receipt = JSON.parse(taken.out).handoff;
    assert.equal(handoffTakenAt(common, outgoingId), receipt.takenAt);

    assert.equal(fs.existsSync(join(outgoing, 'unfinished.bin')), false, 'the completed native takeover cleans the outgoing checkout');
    assert.equal(box.git(outgoing, 'status', '--porcelain').trim(), '');
    const archive = archiveFor(common, outgoing);
    assert.ok(archive, 'handoff cleanup keeps a private recovery archive');
    assertArchivedBytes(archive, 'unfinished.bin', bytes);
    const log = await box.runIn(box.repo, 'log', String(handoffItem), '--json');
    assert.equal(log.code, 0, log.err);
    assert.match(log.out, /Worktree work archived before maintenance cleanup/u);
  });

  test('completed handoff retains dirty source when another native process still works there [B3,C7,N26]', { timeout: 20_000 }, async t => {
    const helpers = createE2eHelpers(); t.after(helpers.cleanup);
    const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }), { withWorktree: false });
    await enable(box);
    const common = retainFixtureTimer(box), outgoing = join(box.dir, 'busy-outgoing'), incoming = join(box.dir, 'busy-incoming');
    const outgoingId = await joinAgent(box, outgoing);
    await joinAgent(box, incoming);
    const bytes = Buffer.from([0, 23, 24, 255]);
    fs.writeFileSync(join(outgoing, 'unfinished.bin'), bytes);
    const opened = await box.runIn(outgoing, 'handoff', '--json');
    assert.equal(opened.code, 0, opened.err);
    const handoffItem = JSON.parse(opened.out).handoff.item;

    const worker = startFixtureChild('/bin/sleep', ['60'], { cwd: outgoing, env: box.env, stdio: 'ignore' });
    t.after(async () => {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill('SIGTERM');
        await once(worker, 'close');
      }
    });
    const observed = () => {
      const rows = workingDirectories();
      return rows?.some(row => row.pid === worker.pid && resolve(row.path) === resolve(outgoing)) ? rows : null;
    };
    await helpers.waitFor(observed, 'the real process census to observe the other process in the outgoing checkout', 5_000); // budget: census observation ceiling, not a timing assertion.

    const taken = await box.runIn(incoming, 'handoff', '--take', String(handoffItem), '--json');
    assert.equal(taken.code, 0, taken.err);
    const receipt = JSON.parse(taken.out).handoff;
    assert.equal(handoffTakenAt(common, outgoingId), receipt.takenAt);
    assert.deepEqual(fs.readFileSync(join(outgoing, 'unfinished.bin')), bytes);
    assert.notEqual(box.git(outgoing, 'status', '--porcelain').trim(), '');
    assert.equal(archiveFor(common, outgoing), null, 'an occupied checkout is retained without an archive/reset');
    const log = await box.runIn(box.repo, 'log', String(handoffItem), '--json');
    assert.equal(log.code, 0, log.err);
    assert.doesNotMatch(log.out, /Worktree work archived before maintenance cleanup/u);
  });
}
