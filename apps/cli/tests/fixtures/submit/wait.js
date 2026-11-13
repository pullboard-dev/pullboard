/** Shared kit for the submit wait journeys: a real project, a waiting submit child, and a one-shot board read [V2,V4,B5,B13,A6]. */
import { withBoardRead } from '../../../index.js';
import { retrySync } from '../../../index.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openBoard } from '../../../../lib/index.js';
import { createE2eHelpers } from '../e2e.js';
import { fixtureAdd } from '../testkit.js';
import { settledGateJob } from './settle.js';

/** Bind the kit to the caller's store module so this fixture stays free of package imports. */
export function waitKit(store) {
  const waitPorts = { withBoardRead, retrySync, events: store.events, verdictsFor: store.verdictsFor, getItem: store.getItem };
  const helpers = createE2eHelpers();

  /** Read one private board without retaining a lock while a real CLI child runs. */
  function onBoard(box, action, clock) {
    // @pullboard-board-file journey: observe the real CLI child's persisted submission and verdict without retaining its lock.
    const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), clock);
    try { return action(board); } finally { store.closeBoard(board); }
  }

  /** Submit through the public CLI, then independently record a real verdict for queue-return tests. */
  async function waitingVerdict(t, decision, { command = 'submit', json = false, builderHeartbeatOffsetMs = 0 } = {}) {
    const box = helpers.project('true');
    assert.equal((await fixtureAdd(box.runLocal, box.repo, 'web', 'Wait for the verdict', '--specs', 'G1', '--route', 'mid',
      '--brief', 'Files:\n- web/wait.txt\nChange:\n- add the submitted fixture file\nTest:\n- the fixture check accepts the submitted source\n',
      '--criterion', 'The fixture check passes.', '--check', 'true')).code, 0);
    assert.equal((await box.runLocal(box.web, 'claim', '1')).code, 0);
    assert.equal(helpers.commitFile(box, box.web, 'web/wait.txt', 'submitted work\n', 'feat(web): await verdict [G1]').status, 0);
    const child = helpers.launch(box, box.web, process.execPath, [helpers.BIN, command, '1', '--wait', ...(json ? ['--json'] : [])]);
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await child.closed;
    });
    // A pulled gate runs on the local runner after submit returns queued; its job's receipt is what moves the item to submitted.
    await settledGateJob(box, 1);
    await helpers.waitFor(() => child.exitCode !== null || onBoard(box, board => store.getItem(board, 1).item_status === 'submitted'), 'a public submission or its actionable refusal', 30_000); // budget: detached submit completion ceiling under concurrent gate load.
    assert.equal(onBoard(box, board => store.getItem(board, 1).item_status), 'submitted', child.stderrText);
    await helpers.waitFor(() => child.exitCode !== null, 'the final gate to end submit before any verdict', 30_000); // budget: detached submit completion ceiling under concurrent gate load.
    await child.closed;
    assert.equal(child.exitCode, 0, child.stdoutText + child.stderrText);
    assert.equal(onBoard(box, board => store.verdictsFor(board, 1).length), 0, 'gate completion requires no review');
    const note = decision === 'ACCEPT' ? 'The submitted fixture meets its bar.' : 'The fixture deliberately rejects this concrete clause.';
    if (builderHeartbeatOffsetMs) {
      onBoard(box, board => store.heartbeatSeat(board, store.getItem(board, 1).item_built_by),
        { now: () => new Date(Date.now() + builderHeartbeatOffsetMs) });
    }
    onBoard(box, board => store.verify(board, 1, { agentId: 'coordinator', decision,
      digest: store.getItem(board, 1).item_frozen_digest, head: store.getItem(board, 1).item_commit,
      reason: decision === 'ACCEPT' ? 'CRITERION_MET' : 'BEHAVIOR_MISMATCH', note, policy: 'any', check: 'green', reopenFirstRefusalMinutes: 30,
      ...(decision === 'REJECT' ? { clause: 'The fixture check passes.' } : {}) }));
    await helpers.waitFor(() => child.exitCode !== null, 'the verdict to end the attached submit');
    await child.closed;
    assert.equal(child.exitCode, 0, 'a later independent verdict does not change the completed gate result');
    if (json) {
      const document = JSON.parse(child.stdoutText);
      assert.equal(document.item, 1);
      assert.ok(document.commit);
      assert.ok(document.gateJob, 'a pulled submit names its gate job instead of a hand-off pin');
      assert.ok((await settledGateJob(box, 1)).gate, 'the settled job receipt carries the gate result');
      assert.equal(document.verdict, undefined, 'submit reports its gate independently of a later review');
    }
    assert.ok(onBoard(box, board => store.verdictsFor(board, 1)).some(row => row.verdict_decision === decision
      && row.verdict_note === note), 'the actual independent verdict and note remain on the board');
    return box;
  }
  return { helpers, waitPorts, onBoard, waitingVerdict };
}
