import assert from 'node:assert/strict';
import * as machineRules from '../../../../../packages/state/index.js';

/** Keep declaration-derived trigger assertions beside the rehome lifecycle additions. */
export function assertRehomeTriggerDeclaration() {
  const moveSql = machine => machineRules.storeTriggers(machine).find(({ name }) => name === 'machine_item_move').sql;
  const pairs = machineRules.MACHINE.moves.flatMap(move => move.from.filter(from => from !== move.to).map(from => `'${from}>${move.to}'`));
  for (const pair of pairs) assert.ok(moveSql(machineRules.MACHINE).includes(pair), `the move trigger allows ${pair}`);
  // The only open-to-verified edge is the source-acceptance import, not a direct verdict.
  assert.deepEqual(machineRules.MACHINE.moves.filter(move => move.from.includes('open') && move.to === 'verified').map(move => move.verb), ['rehomeImport']);
  assert.ok(moveSql(machineRules.MACHINE).includes("'open>verified'"));
  const machine = structuredClone(machineRules.MACHINE);
  machine.moves.push({ verb: 'testDirectVerdict', from: ['withdrawn'], to: 'verified', by: ['coordinator'], refuse: 'CLOSED', guards: ['joined', 'coordinatorOnly', 'itemExists', machineRules.IN_STATE], sets: ['item_built_by', 'item_commit', 'item_frozen_digest'] });
  assert.ok(!moveSql(machineRules.MACHINE).includes("'withdrawn>verified'"));
  assert.ok(moveSql(machine).includes("'withdrawn>verified'"));
  const names = machineRules.storeTriggers().map(({ name }) => name);
  for (const state of machineRules.MACHINE.states.filter(entry => entry.requires.length)) assert.ok(names.includes(`machine_fields_${state.id}`), `${state.id} has a fields trigger`);
  assert.ok(names.includes('machine_proof_verified'));
  const proof = machineRules.storeTriggers().find(({ name }) => name === 'machine_proof_verified').sql;
  assert.match(proof, /AND NOT \(EXISTS[\s\S]+ OR EXISTS[\s\S]+\)\nBEGIN/u,
    'the imported proof alternative stays inside the verified proof refusal condition');
}
