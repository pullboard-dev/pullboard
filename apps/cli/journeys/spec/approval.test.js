/** Hand-written approval is visible without becoming a person's decision [S1,B26,P6]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { configFromSource } from '../../../../packages/config/index.js';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { SPEC_APPROVAL_ENGINE } from '../../../../packages/state/light.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';

/** Run the private project's real CLI and require its structured successful response. */
async function document(box, root, ...args) {
  const result = await box.runIn(root, ...args, '--json');
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  return JSON.parse(result.out);
}

test('a row approved without a person move reads as agent-approved until the person confirms it [S1,B26,P6]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  // This normal fixture's setup commit writes approved rows, without any person row decision.
  const box = helpers.project('true');
  const sourceCommit = box.git(box.repo, 'rev-parse', 'HEAD');
  const initial = await document(box, box.repo, 'status');
  const unconfirmed = (initial.needs ?? []).find(need => need.kind === 'agent-approved' && need.id === 'G1');
  assert.ok(unconfirmed, 'an approved row with no person decision must appear in Needs you as agent-approved');
  assert.equal(unconfirmed.commit, sourceCommit, 'the flag names the commit containing the unconfirmed row');
  assert.ok(unconfirmed.agent, 'the available author attribution is shown, never inferred to be human approval');
  assert.match(unconfirmed.text, /agent-approved/u);

  const added = await document(box, box.repo, 'add', 'web', 'Work on the unconfirmed requirement',
    '--specs', 'G1', '--criterion', 'The fixture page exists.');
  const id = added.item.item_id;
  assert.equal((await box.runIn(box.web, 'claim', String(id))).code, 0, 'the default flag does not block work');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/page.js'), 'export const page = true;\n');
  box.git(box.web, 'add', 'web/page.js');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): add the fixture page [G1]');
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  await document(box, box.web, 'submit', String(id), '--wait', '--no-next');
  const review = join(box.dir, 'independent-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  // An unrouted item is strong, so its reviewer joins strong.
  await document(box, review, 'join', 'api', '--route', 'strong');
  const verified = await box.runIn(review, 'verify', String(id), 'accept', '--note', 'The real fixture gate passed on the submitted commit.');
  assert.equal(verified.code, 0, `${verified.out}\n${verified.err}`);
  assert.match(verified.out, /verified against agent-approved G1/u);
  const exported = await document(box, box.repo, 'export');
  const acceptance = exported.tables.event.findLast(event => event.item_id === id && event.event_kind === 'accept');
  assert.ok(acceptance, 'the normal independent verification produced a receipt');
  assert.match(acceptance.event_detail, /verified against agent-approved G1/u);
  const ledger = await box.runIn(box.repo, 'ledger');
  assert.equal(ledger.code, 0, ledger.err);
  assert.match(ledger.out, /verified against agent-approved G1/u);

  // Only this isolated fixture simulates a marked agent and a separate ordinary person terminal.
  const agent = await runCliInProcess(['spec', 'approve', 'G1', '--json'], {
    cwd: box.web, env: { ...box.env, CLAUDECODE: '1' },
  });
  assert.equal(agent.status, 1);
  assert.equal(JSON.parse(agent.stdout).error.code, 'B26_PERSON_CHANNEL', 'an agent cannot confirm its own approval');
  await document(box, box.repo, 'spec', 'approve', 'G1');
  const confirmed = await document(box, box.repo, 'status');
  assert.equal((confirmed.needs ?? []).some(need => need.kind === 'agent-approved' && need.id === 'G1'), false,
    'one person decision confirms the exact row without a separate apply step');
  const after = await box.runIn(box.repo, 'ledger');
  assert.equal(after.code, 0, after.err);
  assert.doesNotMatch(after.out, /verified against agent-approved G1/u, 'the current ledger reflects the confirmation');
  const kept = (await document(box, box.repo, 'export')).tables.event.find(event => event.event_id === acceptance.event_id);
  assert.equal(kept.event_detail, acceptance.event_detail, 'confirmation never rewrites the historical verification receipt');
});

test('agent approval settings preserve the filename form and reject ambiguous choices [S1,P6]', () => {
  assert.equal(configFromSource('{}').specAgentApproval, 'flag');
  assert.equal(configFromSource('{"spec":"requirements.md"}').spec, 'requirements.md');
  for (const agentApproval of ['flag', 'allow', 'refuse']) {
    const config = configFromSource(JSON.stringify({ spec: { file: 'requirements.md', agentApproval } }));
    assert.equal(config.spec, 'requirements.md');
    assert.equal(config.specAgentApproval, agentApproval);
  }
  for (const spec of [null, [], { file: 'SPEC.md', agentApproval: null }, { file: 'SPEC.md', agentApproval: 'trust' }]) {
    assert.throws(() => configFromSource(JSON.stringify({ spec })), error => error.code === 'BAD_CONFIG');
  }
  // Forward compatibility landed after this case: an unknown key warns and is ignored, so it can never grant approval.
  const unknown = configFromSource(JSON.stringify({ spec: { file: 'SPEC.md', agentApproval: 'flag', agent: 'person' } }));
  assert.equal(unknown.specAgentApproval, 'flag', 'an unknown spec key changes no approval setting');
});

test('allow suppresses approval calls and explicit refuse protects a new claim [S1,B26,P6]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  for (const mode of ['allow', 'refuse']) {
    const box = helpers.project('true');
    const file = join(box.repo, 'pullboard.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...config, spec: { file: 'SPEC.md', agentApproval: mode } }, null, 2) + '\n');
    box.git(box.repo, 'add', 'pullboard.json');
    box.git(box.repo, 'commit', '-q', '-m', 'chore(config): choose approval policy');
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    const initial = await document(box, box.repo, 'status');
    assert.equal(initial.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), mode !== 'allow');
    const id = (await document(box, box.repo, 'add', 'web', 'Policy-controlled fixture', '--specs', 'G1', '--criterion', 'A real fixture.')).item.item_id;
    const claimed = await box.runIn(box.web, 'claim', String(id), '--json');
    if (mode === 'allow') assert.equal(claimed.code, 0, `${claimed.out}\n${claimed.err}`);
    else {
      assert.equal(claimed.code, 1);
      assert.equal(JSON.parse(claimed.out).error.code, 'AGENT_APPROVAL_REQUIRED');
      await document(box, box.repo, 'spec', 'approve', 'G1');
      assert.equal((await box.runIn(box.web, 'claim', String(id))).code, 0, 'the exact person decision unblocks an explicit refuse policy');
    }
  }
});

test('confirmation follows the exact row and an unsigned ledger cannot impersonate it [S1,S19,P6]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const before = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const line = before.split('\n').find(text => text.startsWith('- G1 '));
  mkdirSync(join(box.repo, '.pullboard'), { recursive: true });
  writeFileSync(join(box.repo, '.pullboard/signoffs.jsonl'), JSON.stringify({ version: 1, type: 'row-decision', kind: 'spec',
    file: 'SPEC.md', id: 'G1', decision: 'approve', by: 'person', source: line, replacement: line, text: 'The page renders.' }) + '\n');
  assert.ok((await document(box, box.repo, 'status')).needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'),
    'a hand-written unsigned receipt is not person approval');
  await document(box, box.repo, 'spec', 'approve', 'G1');
  assert.equal((await document(box, box.repo, 'status')).needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), false);
  writeFileSync(join(box.repo, 'SPEC.md'), before.replace('The page renders.', 'The changed page renders.'));
  const changed = (await document(box, box.repo, 'status')).needs.find(need => need.kind === 'agent-approved' && need.id === 'G1');
  assert.ok(changed, 'an approval of earlier wording cannot confirm a changed row');
  assert.equal(changed.commit, null, 'uncommitted wording never borrows a committed row attribution');
  await document(box, box.repo, 'spec', 'approve', 'G1');
  assert.equal((await document(box, box.repo, 'status')).needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), false);
});

test('the actual API reports approval calls and accepts one person confirmation [A9,S1,P6]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const view = await helpers.startView(box, box.repo);
  t.after(view.stop);
  const before = (await view.state(box.repo)).project;
  assert.ok(before.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'));
  assert.equal(before.spec.find(row => row.id === 'G1').agentApproval.attribution, 'Git author, seat unknown');
  const confirmed = await view.act(box.repo, { verb: 'spec-approve', args: { ids: 'G1' } });
  assert.equal(confirmed.status, 200);
  const after = (await view.state(box.repo)).project;
  assert.equal(after.needs.some(need => need.kind === 'agent-approved' && need.id === 'G1'), false);
  assert.equal(after.spec.find(row => row.id === 'G1').agentApproval, null);
});

test('approval projection leaves a board with no Spec readable [I10,S1,P6]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const id = (await document(box, box.repo, 'add', 'web', 'An item needs no spec rows')).item.item_id;
  rmSync(join(box.repo, 'SPEC.md'));
  assert.equal((await document(box, box.repo, 'status')).needs.some(need => need.kind === 'agent-approved'), false);
  assert.equal((await document(box, box.repo, 'show', String(id))).agentApproved.length, 0);
  assert.deepEqual((await document(box, box.repo, 'ledger')).items, []);
  const view = await helpers.startView(box, box.repo);
  t.after(view.stop);
  const state = (await view.state(box.repo)).project;
  assert.deepEqual(state.spec, []);
  assert.equal(state.needs.some(need => need.kind === 'agent-approved'), false);
});

test('only new-engine acceptance receipts retain the verification note [H16,S1,P6]', t => {
  const payloads = [];
  const note = 'Fixture verification note; verified against agent-approved G1';
  for (const version of [SPEC_APPROVAL_ENGINE - 1, SPEC_APPROVAL_ENGINE]) {
    const board = openBoard(':memory:');
    t.after(() => store.closeBoard(board));
    const builder = store.register(board, { lane: 'web', path: '/fixture-builder', model: 'Fixture builder' });
    const reviewer = store.register(board, { lane: 'review', path: '/fixture-reviewer', model: 'Fixture reviewer' });
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Versioned receipt' });
    const frozen = { text: JSON.stringify({ rows: [], policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } }), digest: 'f'.repeat(64) };
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, head: 'a'.repeat(40), freeze: () => frozen });
    submitFixture(board, id, { agentId: builder, commit: 'b'.repeat(40), tree: 'c'.repeat(40) });
    board.executionEngineVersion = version;
    store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', note, head: 'b'.repeat(40), digest: frozen.digest,
      policy: 'any', check: 'green', review: { commit: 'b'.repeat(40), head: 'b'.repeat(40), trunk: 'a'.repeat(40), paths: [] } });
    const detail = JSON.parse(store.events(board, { itemId: id }).find(event => event.event_kind === 'accept').event_detail);
    assert.equal(detail.note, version >= SPEC_APPROVAL_ENGINE ? note : undefined);
    const { note: recorded, ...historical } = detail;
    payloads.push(historical);
  }
  assert.deepEqual(payloads[0], payloads[1], 'every existing receipt field retains its earlier replay meaning');
});
