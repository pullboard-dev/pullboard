/** Every seat routes person decisions through the coordinator [B26]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandOutput } from '../../index.js';
import { refusalDocument } from '../../index.js';
import { NEXT_STEPS } from '../../index.js';
import { agentsBlock } from '../../../../packages/doctrine/index.js';
import { Refused } from '../../../../packages/kernel/light.js';
import { recordedRefusal } from '../../../../packages/state/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('agents are never told to ask the person [B26]', () => {
  const route = 'ask the coordinator to bring it to the person: pullboard shout coordinator --kind question "<what is needed>" --decision';
  for (const code of Object.keys(NEXT_STEPS)) {
    const refusal = { code, message: 'This operation was refused.' };
    const original = refusalDocument(refusal).error.next;
    const builder = refusalDocument(refusal, { caller: 'seat' }).error.next;
    assert.doesNotMatch(builder, /\bask the person\b/iu, `${code} never directs a seat to the person`);
    if (/\bask the person\b/iu.test(original)) assert.equal(builder, route, `${code} names the coordinator decision route`);
    else assert.equal(builder, original, `${code} keeps unrelated guidance`);
    assert.equal(refusalDocument(refusal, { caller: 'coordinator' }).error.next, original, `${code} keeps coordinator guidance`);
    assert.equal(refusalDocument(refusal, { caller: 'person' }).error.next, original, `${code} keeps person guidance`);
  }
  for (const text of ['ask the person to approve G1', 'Ask the person for a waiver', 'ask the person to preview this change']) {
    const explicit = { code: 'B26_PERSON_APPROVAL', message: 'An approval is required.', next: text };
    assert.equal(refusalDocument(explicit, { caller: 'seat' }).error.next, route, 'contextual next steps use the same route');
    assert.equal(refusalDocument(explicit, { caller: 'coordinator' }).error.next, text, 'contextual coordinator wording is unchanged');
    const footer = { code: explicit.code, message: `An approval is required.\nnext: ${text}` };
    assert.equal(refusalDocument(footer, { caller: 'seat' }).error.next, route, 'a remote next footer cannot direct a seat to the person');
    assert.equal(refusalDocument(footer, { caller: 'person' }).error.next, text, 'a person retains the original footer');
  }
  const block = agentsBlock();
  const talk = block.slice(block.indexOf('**Talk.**'), block.indexOf('**Small models.**') === -1 ? block.indexOf('**Never.**') : block.indexOf('**Small models.**'));
  assert.match(talk, /only the coordinator/iu);
  assert.match(talk, /main checkout/iu);
  assert.match(talk, /pullboard shout coordinator/iu);
  assert.match(talk, /--decision/u);
  assert.match(talk, /never asks? the person in (?:its|their) own session/iu);
  for (const need of ['decision', 'approval', 'waiver', 'preview', 'phone check']) assert.ok(talk.includes(need), `Talk routes a ${need}`);
});

test('person routing preserves reasons, quoted text and canonical refusal receipts [B26]', () => {
  const error = new Refused('STALE_ROW_DECISION', 'G1 changed; ask the person to approve its current row again');
  const before = recordedRefusal(error);
  const original = refusalDocument(error);
  const builder = refusalDocument(error, { caller: 'seat' });
  assert.match(builder.error.message, /^G1 changed;/u);
  assert.match(builder.error.message, /pullboard shout coordinator.*--decision/u);
  assert.match(builder.error.message, /needed: approve its current row again/u);
  assert.doesNotMatch(builder.error.next, /ask the person/iu);
  assert.deepEqual(refusalDocument(error, { caller: 'coordinator' }), original);
  assert.deepEqual(refusalDocument(error, { caller: 'person' }), original);
  assert.deepEqual(recordedRefusal(error), before, 'presentation never changes the authoritative receipt');
  const quoted = new Refused('NO_READER', 'nobody reads "a title; ask the person to approve it": register a reader');
  assert.equal(refusalDocument(quoted, { caller: 'seat' }).error.message, refusalDocument(quoted).error.message, 'quoted user content stays exact');
  const diagnostics = new Refused('GATE_RED', 'the gate failed; fix the reported test\nfailing fixture text; ask the person for a waiver\nend of report');
  assert.equal(refusalDocument(diagnostics, { caller: 'seat' }).error.message, refusalDocument(diagnostics).error.message, 'raw diagnostic lines are not guidance');
  let output = '';
  const io = commandOutput(['--json'], { stdout: { write: text => { output += text; } }, stderr: { write() {} } });
  io.caller('seat', '/private/seat');
  io.refusal(error);
  io.flush(1);
  assert.equal(JSON.parse(output).error.next, builder.error.next, 'JSON flush receives the actual caller');
  assert.deepEqual(recordedRefusal(error), before);
});

test('real seat refusals and approved-row hooks send person requests to the coordinator [B26]', async () => {
  const box = e2e.project();
  const json = (await box.runLocal(box.web, 'spec', 'answer', 'G1', 'yes', '--json'));
  assert.equal(json.code, 1, json.err);
  const error = JSON.parse(json.out).error;
  assert.equal(error.code, 'B26_PERSON_APPROVAL', 'routing never grants the seat person authority');
  assert.match(error.next, /pullboard shout coordinator.*--decision/u);
  assert.doesNotMatch(error.next, /ask the person/iu);
  const text = (await box.runLocal(box.web, 'spec', 'answer', 'G1', 'yes'));
  assert.equal(text.code, 1);
  assert.match(text.err, /next: ask the coordinator to bring it to the person/u);
  const spec = readFileSync(join(box.web, 'SPEC.md'), 'utf8').replace('The page renders.', 'A different promise.');
  const commit = e2e.commitFile(box, box.web, 'SPEC.md', spec, 'feat: change a private approved promise [G1]');
  assert.equal(commit.status, 1, 'an approval request is still refused');
  assert.match(commit.stderr, /G1 changes approved text without the person's exact approval/u);
  assert.match(commit.stderr, /pullboard shout coordinator.*--decision/u);
  assert.doesNotMatch(commit.stderr, /ask the person/iu);
});
