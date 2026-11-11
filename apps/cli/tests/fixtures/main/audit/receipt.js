/** Exercise native binding and replay only with a real runGate receipt supplied by the actual audit fixture [C7,H16]. */
import assert from 'node:assert/strict';
import {
  prepareEngineMove,
  applyEngineMove,
  appliedSequence,
} from '../../../../../../packages/state/index.js';
import { MAIN_AUDIT_ENGINE } from '../../../../../../packages/state/light.js';
import { getItem } from '../../../../../../packages/store/index.js';
import { recordLandingTestDefect } from '../../../../../../packages/store/index.js';
import {
  gateRuns,
  recordGateRun,
} from '../../../../../../packages/flakes/index.js';

/** Caller supplies two native boards with the same genuinely recorded landing history, plus the real stored run. */
export function assertMainAuditReceiptReplay(origin, replica, request, at) {
  // prepareEngineMove itself reads the origin's private gate receipt store, so no synthetic schema input can pass.
  const move = prepareEngineMove(origin, 'recordGateRun', [request]);
  assert.ok(move.args[0].receipt.collection);
  const sequence = appliedSequence(replica) + 1;
  assert.throws(() => applyEngineMove(replica, { ...move, engine: MAIN_AUDIT_ENGINE - 1 }, { sequence, at }),
    error => error.code === 'RELAY_MOVE', 'a receiver cannot silently strip collection evidence');
  assert.equal(appliedSequence(replica), sequence - 1);
  const applied = applyEngineMove(replica, move, { sequence, at });
  assert.equal(applied.error, undefined);
  const row = gateRuns(replica).find(entry => entry.id === request.receipt.id);
  assert.deepEqual(row.collection, request.receipt.collection);
  assert.deepEqual(applyEngineMove(replica, move, { sequence, at }), applied, 'identical original receipt replay is stable');
  // A direct domain call with an explicit old replay context also refuses; no field disappears in normalization.
  replica.executionEngineVersion = MAIN_AUDIT_ENGINE - 1;
  try { assert.throws(() => recordGateRun(replica, request), error => error.code === 'ENGINE_VERSION'); }
  finally { delete replica.executionEngineVersion; }
  const changed = structuredClone(request);
  changed.receipt.collection.complete = !changed.receipt.collection.complete;
  assert.throws(() => prepareEngineMove(origin, 'recordGateRun', [changed]), error => error.code === 'GATE_RUN_UNBOUND',
    'changing native collection facts never reuses the real stored receipt');
}


/** Replay open-repair routing from actual failed-run fields and real withdrawn-item history. */
export function assertMainAuditOpenRouteReplay(origin, replica, request, closedId, at) {
  const before=getItem(replica,closedId);
  assert.equal(before.item_status,'withdrawn');
  const move=prepareEngineMove(origin,'recordLandingTestDefect',[request]);
  assert.equal(move.args[0].requireOpen,true);
  const sequence=appliedSequence(replica)+1;
  assert.throws(()=>applyEngineMove(replica,{...move,engine:MAIN_AUDIT_ENGINE-1},{sequence,at}),
    error=>error.code==='RELAY_MOVE','old receiver cannot reuse closed route by dropping open-repair mode');
  assert.equal(appliedSequence(replica),sequence-1);
  assert.deepEqual(getItem(replica,closedId),before);
  const applied=applyEngineMove(replica,move,{sequence,at});
  assert.equal(applied.error,undefined);
  // Read native resulting history rather than assuming the engine outcome embeds a domain return shape.
  const defects=replica.db.prepare("SELECT event_detail FROM event WHERE event_kind='landing-test-defect' ORDER BY event_id").all();
  const defect=JSON.parse(defects.at(-1).event_detail).defect;
  assert.notEqual(defect.item,closedId);assert.equal(getItem(replica,defect.item).item_status,'open');
  assert.equal(defect.batchId,request.batchId);assert.deepEqual(defect.names,request.names);
  assert.deepEqual(getItem(replica,closedId),before);
  assert.deepEqual(applyEngineMove(replica,move,{sequence,at}),applied,'exact open-repair receipt replay is stable');
  replica.executionEngineVersion=MAIN_AUDIT_ENGINE-1;
  try{assert.throws(()=>recordLandingTestDefect(replica,request),error=>error.code==='ENGINE_VERSION');}
  finally{delete replica.executionEngineVersion;}
}
