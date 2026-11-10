/** @pullboard-test-input source-tree */
/** @pullboard-test-loads packages/spec/src/logic/row/replacement.js */
/** One person-facing obligation builder across sessions and transports [N26,A9]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { main } from '../../tests/fixtures/native.js';
import { parseSpec } from '../../../../packages/spec/index.js';
import { personNeeds } from '../../../../packages/spec/index.js';
import { serveMcp } from '../../../../packages/mcp/index.js';
import { personNeedsState } from '../../../view/index.js';
import { refusalDocument } from '../../index.js';
import { writeLegacyWebQuestions } from '../../tests/fixtures/blueprint/question.js';
import { readBlueprint } from '../../../../packages/blueprints/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

test('one builder lists what needs the person [N26,A9]', async (t) => {
  assert.ok(existsSync(new URL('../../../../packages/spec/src/logic/row/replacement.js', import.meta.url)), 'the shared personNeeds builder exists');
  assert.equal(typeof personNeeds, 'function');
  assert.doesNotMatch(readFileSync(new URL("../../../../packages/spec/src/logic/row/replacement.js", import.meta.url), 'utf8'), /^\s*import\b/mu, 'the browser builder has no imports');
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8') + `
- G3 [pending, aim] Which storage backend?
- G4 [pending, aim] Keep the decided backend.
- G5 [pending, aim] Do not resurrect the declined proposal.
- G6 [draft, aim] Review the proposed retry policy.
`;
  writeFileSync(join(box.repo, 'SPEC.md'), spec);
  box.git(box.repo, 'add', 'SPEC.md');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: describe person needs fixture');
  // Copy only the fixture spec into its agent worktree; every decision stays on the shared real board.
  writeFileSync(join(box.web, 'SPEC.md'), spec);
  for (const args of [
    ['spec', 'approve', 'G4'],
    ['spec', 'decline', 'G5', '--reason', 'The person rejected this design.'],
    ['shout', 'person', 'Which public interface should we keep?', '--decision'],
    ['hold', 'web', '--reason', 'Await the interface decision.'],
  ]) {
    const result = box.run(box.repo, ...args);
    assert.equal(result.code, 0, result.err || result.out);
  }
  // A real resume reads the same pending, unapplied decisions as the MCP tool.
  const resumed = box.run(box.repo, 'resume', '--json');
  assert.equal(resumed.code, 0, resumed.err || resumed.out);
  const card = JSON.parse(resumed.out);
  assert.ok(Array.isArray(card.needsYou), 'resume exposes the shared person needs list');
  const expected = card.needsYou;
  assert.deepEqual(expected.map(need => need.kind).sort(), ['agent-approved', 'agent-approved', 'decision', 'draft', 'hold', 'pending']);
  assert.deepEqual(expected.filter(need => need.kind === 'agent-approved').map(need => need.id).sort(), ['G1', 'G2'],
    'approved source added after init stays visibly unconfirmed');
  assert.equal(expected.find(need => need.kind === 'pending').id, 'G3');
  assert.equal(expected.find(need => need.kind === 'draft').count, 1);
  assert.equal(expected.find(need => need.kind === 'hold').id, 'web');
  assert.equal(expected.find(need => need.kind === 'decision').text, 'Which public interface should we keep?');
  assert.ok(!expected.some(need => ['G4', 'G5'].includes(need.id)), 'approved and declined unapplied rows stay out');
  const state = personNeedsState(box.repo);
  assert.deepEqual(personNeeds(state), expected);
  const statusCard = box.run(box.repo, 'status', '--json');
  assert.equal(statusCard.code, 0, statusCard.err || statusCard.out);
  assert.deepEqual(JSON.parse(statusCard.out).needs, expected, 'lightweight status preserves every kind of person obligation');
  const before = JSON.stringify(state);
  const browserBuilder = runInNewContext(`(${personNeeds.toString()})`);
  assert.deepEqual(JSON.parse(JSON.stringify(browserBuilder(state))), expected,
    'the standalone source evaluates in an empty VM with no closure or imports');
  assert.equal(JSON.stringify(state), before, 'the builder changes no input');
  assert.deepEqual(personNeeds({}), [], 'an empty projection has no obligations');
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'board_status', arguments: {} } };
  let output = '';
  let diagnostics = '';
  const status = await serveMcp({ cwd: box.repo, input: Readable.from([JSON.stringify(request) + '\n']),
    output: { write: text => { output += text; } }, log: { write: text => { diagnostics += text; } }, runCommand: main,
    readPersonNeeds: cwd => personNeeds(personNeedsState(cwd)), formatRefusal: refusalDocument });
  assert.equal(status, 0, diagnostics);
  const reply = JSON.parse(output);
  assert.equal(reply.result?.isError, false, JSON.stringify(reply));
  assert.deepEqual(reply.result.structuredContent.needsYou, expected, 'MCP uses the same complete list');
});


test('a pending question names pullboard spec answer [S1,B26]', async (t) => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.sandbox();
  const repo = join(box.dir, 'newcomer');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const initialized = box.run(repo, 'init', '--blueprint', writeLegacyWebQuestions(repo, readBlueprint('web-app')));
  assert.equal(initialized.code, 0, initialized.err || initialized.out);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: preserve newcomer setup');
  const file = join(repo, 'SPEC.md');
  const source = readFileSync(file, 'utf8');
  const question = parseSpec(source).rows.find(row => row.status === 'pending' && row.text.startsWith('The app is built with:'));
  assert.ok(question, 'the explicit question template files its framework question');

  // Reproduce the dead end invited by the old wording, then restore the exact pending source.
  writeFileSync(file, source.replace(`- ${question.id} [pending,`, `- ${question.id} [approved,`));
  const handEdit = box.run(repo, 'spec', 'check');
  assert.notEqual(handEdit.code, 0);
  assert.match(handEdit.out + handEdit.err, /pending question answered by hand/u);
  writeFileSync(file, source);

  const resumed = box.run(repo, 'resume', '--json');
  assert.equal(resumed.code, 0, resumed.err || resumed.out);
  const pending = JSON.parse(resumed.out).needsYou.filter(need => need.kind === 'pending');
  assert.equal(pending.length, 4, 'all four explicit blueprint questions remain visible');
  for (const need of pending) assert.equal(need.what, `pullboard spec answer ${need.id} "<choice>"`);
  const human = box.run(repo, 'resume');
  assert.equal(human.code, 0, human.err || human.out);
  assert.doesNotMatch(human.out, /answer in SPEC\.md/u);
  assert.ok(human.out.includes(`pullboard spec answer ${question.id} "<choice>"`));
  const browserBuilder = runInNewContext(`(${personNeeds.toString()})`);
  const browserNeeds = browserBuilder({ spec: parseSpec(source).rows }).filter(need => need.kind === 'pending');
  assert.deepEqual(JSON.parse(JSON.stringify(browserNeeds)), pending, 'the standalone browser builder gives the same commands');

  const answered = box.run(repo, 'spec', 'answer', question.id, 'SvelteKit');
  assert.equal(answered.code, 0, answered.err || answered.out);
  assert.equal(readFileSync(file, 'utf8'), source, 'the command records the decision before changing the file');
  const applied = box.run(repo, 'spec', 'apply');
  assert.equal(applied.code, 0, applied.err || applied.out);
  const row = parseSpec(readFileSync(file, 'utf8')).rows.find(row => row.id === question.id);
  assert.equal(row.status, 'approved');
  assert.match(row.text, /^The app is built with: SvelteKit\./u);
  const checked = box.run(repo, 'spec', 'check');
  assert.equal(checked.code, 0, checked.err || checked.out);
});

test('only materialized Rigor proposals need the person while coordinator work stays intact [N26,B26,A6]', async () => {
  const waiting = { kind: 'rigor-draft', id: 'doctrine:RG1', target: 'doctrine:RG1', unproved: true, materialized: false,
    text: 'Review a repeated cause.', evidence: { occurrences: 2 }, what: 'Coordinator: materialize with pullboard spec apply' };
  const ready = { ...waiting, id: 'doctrine:RG2', target: 'doctrine:RG2', materialized: true };
  const collision = { ...ready, id: 'doctrine:RG3', collision: true };
  const proved = { kind: 'rigor-draft', id: 'spec:G3', target: 'spec:G3', text: 'A proved draft.' };
  const state = { rigorDrafts: [waiting, ready, collision, proved] };
  const before = JSON.stringify(state);
  assert.deepEqual(personNeeds(state).map(row => row.id), ['doctrine:RG2', 'spec:G3']);
  assert.equal(personNeeds(state)[0].unproved, true, 'materialization does not invent executed proof');
  assert.equal(JSON.stringify(state), before, 'coordinator proposals and their evidence remain available');
  const browserBuilder = runInNewContext(`(${personNeeds.toString()})`);
  assert.deepEqual(JSON.parse(JSON.stringify(browserBuilder(state))), personNeeds(state), 'browser and server share the exact filter');
});
