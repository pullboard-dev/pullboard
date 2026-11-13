/** A refusal and relay status name pullboard relay recover, and status reads healthy once the queue drains (#6693) [B26,H16,H17]. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeMove,
  refusalLine,
} from '../../../../packages/outbox/index.js';
import { briefLines } from '../../../../packages/link/src/io/relay/output.js';
import { parkedBoard } from '../../tests/fixtures/relay/parked.js';

/** The command every refusal and status line names. */
const RECOVER = 'pullboard relay recover';

test('clause 3: the refusal and relay status name pullboard relay recover, and status reads healthy once the queue drains [B26,H16,H17]', { timeout: 280_000 }, async (t) => {
  const { box, synced } = await parkedBoard(t);
  const parked = synced.document.relay.outbox[0].parked;
  assert.equal(parked.next, RECOVER, 'the parked move names the one command');
  assert.notEqual(synced.document.relay.health.status, 'healthy', 'a board with a parked move does not read healthy');
  assert.ok(synced.document.relay.health.text.includes(RECOVER), 'the health line names the command');
  const lines = briefLines({ linked: true, sequence: 1, behind: 1, outbox: synced.document.relay.outbox }, { describeMove, refusalLine });
  assert.ok(lines.some((line) => line.includes(RECOVER) && /parked/u.test(line)), 'status output names the command beside the parked move');
  assert.equal((await box.cliLocal('relay', 'recover')).code, 0);
  const drained = await box.cliLocal('status');
  assert.equal(drained.document.relay.outbox, undefined, 'the queue drained');
  assert.equal(drained.document.relay.health.status, 'healthy', 'status reads healthy');
});
