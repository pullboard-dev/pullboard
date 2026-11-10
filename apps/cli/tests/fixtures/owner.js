/** Real CLI requests preserve effects while native current rows determine advice [D1,N26,H16]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from './e2e.js';

/** Require an actual successful private command, including its structured result. */
function document(box, cwd, ...args) {
  const result = box.run(cwd, ...args, '--json');
  assert.equal(result.code, 0, result.err || result.out);
  return JSON.parse(result.out);
}

/** Ask through the real parser and append pipeline; no test directly supplies a computed owner. */
function ask(box, text, effects, ...args) {
  return document(box, box.web, 'shout', 'coordinator', text, '--kind', 'question', '--decision', '--effects', JSON.stringify(effects), ...args);
}

/** Prove persistence, live row re-evaluation, escalation and unchanged execution authority. */
export function proveRulingOwnerCli(t) {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  const ownEffects = [{ op: 'implement-row', row: 'G1' }];
  const own = ask(box, 'Implement the existing requirement?', ownEffects);
  assert.equal(own.ruling.owner, 'agent');
  const reviseEffects = [{ op: 'revise-row', row: 'G1' }];
  const revise = ask(box, 'Revise the governing requirement?', reviseEffects);
  assert.equal(revise.ruling.owner, 'person');
  const id = document(box, box.repo, 'add', 'web', 'Concrete target', '--criterion', 'Keep the page requirement.').item.item_id;
  const coordination = ask(box, 'Withdraw the obsolete item?', [{ op: 'withdraw', item: id }]);
  assert.equal(coordination.ruling.owner, 'coordinator');
  let queue = document(box, box.repo, 'decisions').decisions;
  assert.deepEqual(queue.find(row => row.shout_id === own.id).effects, ownEffects);
  assert.equal(queue.find(row => row.shout_id === own.id).ruling.owner, 'agent', 'a fresh process reads the durable declaration and current rows');
  assert.equal(queue.find(row => row.shout_id === coordination.id).ruling.owner, 'coordinator');
  const denied = box.run(box.web, 'withdraw', String(id), 'The resolver said coordinator', '--json');
  assert.notEqual(denied.code, 0);
  assert.equal(JSON.parse(denied.out).error.code, 'COORDINATOR_ONLY', 'computed ownership grants no permission');
  assert.equal(document(box, box.web, 'show', String(id)).item_status, 'open');
  const directPerson = box.run(box.web, 'shout', 'person', 'May the row change?', '--decision', '--effects', JSON.stringify(reviseEffects), '--json');
  assert.notEqual(directPerson.code, 0);
  assert.equal(JSON.parse(directPerson.out).error.code, 'B26_PERSON_DECISION', 'person advice preserves the coordinator escalation boundary');
  document(box, box.web, 'claim', String(id));
  const choices = ['Keep the row', 'Revise the row'];
  const combined = ask(box, 'Which change should this item make?', reviseEffects, '--item', String(id), '--options', JSON.stringify(choices));
  assert.equal(combined.ruling.owner, 'person');
  const passed = document(box, box.repo, 'pass', String(combined.id), 'The governing row needs the person.');
  const personQueue = document(box, box.repo, 'decisions', '--as', 'person').decisions;
  assert.deepEqual(personQueue.find(row => row.shout_id === passed.id).effects, reviseEffects);
  assert.deepEqual(personQueue.find(row => row.shout_id === passed.id).options, choices);
  assert.equal(personQueue.find(row => row.shout_id === passed.id).item, id);
  assert.equal(personQueue.find(row => row.shout_id === passed.id).ruling.owner, 'person');
  // This is the private fixture's source, not the user's repository or an agent-supplied status field.
  writeFileSync(join(box.repo, 'SPEC.md'), '# Demo spec\n\n## G\n- G1 [draft, must] The page renders. | gate: web test\n- G2 [approved, must] The API answers. | gate: api test\n');
  queue = document(box, box.repo, 'decisions').decisions;
  const changed = queue.find(row => row.shout_id === own.id);
  assert.equal(changed.ruling.owner, null, 'an old implementation request does not retain agent ownership after the governing row changes');
  assert.equal(changed.ruling.code, 'RULING_ROW');
  assert.deepEqual(changed.effects, ownEffects, 're-evaluation does not rewrite the original request');
  const legacy = document(box, box.web, 'shout', 'coordinator', 'An ordinary old-style question', '--kind', 'question', '--decision');
  const plain = document(box, box.repo, 'decisions').decisions.find(row => row.shout_id === legacy.id);
  assert.equal(plain.effects, undefined);
  assert.equal(plain.ruling, undefined);
}

/** Reject malformed or forged declarations before a successful shout is appended. */
export function proveRulingOwnerRefusals(t) {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  const before = document(box, box.repo, 'log').events.length;
  for (const effects of [[], { effects: [{ op: 'withdraw', item: 1 }], owner: 'agent' },
    [{ op: 'withdraw' }], [{ op: 'implement-row', row: 'G1', status: 'approved' }],
    [{ op: 'revise-row', row: 'G1', owner: 'agent' }], [{ op: 'implement-row', row: 'Missing' }]]) {
    const result = box.run(box.web, 'shout', 'coordinator', 'A concrete request', '--kind', 'question', '--decision', '--effects', JSON.stringify(effects), '--json');
    assert.notEqual(result.code, 0);
    assert.match(JSON.parse(result.out).error.code, /^RULING_/u);
  }
  const ordinary = box.run(box.web, 'shout', 'coordinator', 'Not a decision', '--effects', '[{"op":"implement-row","row":"G1"}]', '--json');
  assert.notEqual(ordinary.code, 0);
  assert.equal(JSON.parse(ordinary.out).error.code, 'RULING_EFFECTS');
  assert.equal(document(box, box.repo, 'log').events.length, before, 'malformed declarations append no message or governing event');
}
