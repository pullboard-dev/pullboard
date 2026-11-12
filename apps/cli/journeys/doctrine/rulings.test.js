/** Person-approved rulings reach independent, unadvanced Git checkouts [D1,D3,B27]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { parseSpec } from '../../../../packages/spec/index.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

/** Send one move through the agent API's executeMove, as an agent tool or the relay would. */
function apiMove(box, cwd, move) {
  const api = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/api/index.js')).href;
  const cli = pathToFileURL(resolve(import.meta.dirname, '../../tests/fixtures/native.js')).href;
  const person = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/person/index.js')).href;
  const source = `
    const { executeMove } = await import(${JSON.stringify(api)});
    const { main } = await import(${JSON.stringify(cli)});
    const { moveArgs } = await import(${JSON.stringify(person)});
    const { openBoard, openBoardForRead } = await import(${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)});
    const apiBoardOpeners = { moveArgs, openBoard, openBoardForRead };
    process.stdout.write(JSON.stringify(await executeMove(process.cwd(), ${JSON.stringify(move)}, main, undefined, 'api', undefined, apiBoardOpeners)));
  `;
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { cwd, env: box.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  return JSON.parse(child.stdout);
}

/** Run the real CLI with extra environment, such as an agent shell's marker. */
async function runWith(box, cwd, env, ...args) {
  const result = await runCliInProcess(args, { cwd, env: { ...box.env, ...env } });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test('a ruling the person approves reaches every agent once [D1,D3,B27]', async (t) => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const other = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'web/two', other);
  const joined = await fixtureJoin(box.inProcess, other, 'web', '--model', 'Fixture', '--route', 'strong');
  assert.equal(joined.code, 0, joined.err || joined.out);
  const checkouts = [box.repo, box.web, other];
  const oldHeads = checkouts.map(path => box.git(path, 'rev-parse', 'HEAD'));
  /** Run a real CLI command and require its public, versioned successful result. */
  async function json(path, ...args) {
    const result = await box.inProcess(path, ...args, '--json');
    assert.equal(result.code, 0, result.err || result.out);
    return JSON.parse(result.out);
  }
  for (const path of checkouts) assert.deepEqual((await json(path, 'resume')).doctrineNotes ?? [], []);
  const file = join(box.repo, 'DOCTRINE.md');
  const before = readFileSync(file, 'utf8');
  const missing = await box.inProcess(box.repo, 'spec', 'draft', 'Keep the approved ruling.', '--doctrine', '--json');
  assert.notEqual(missing.code, 0, 'a proposal without its source is refused');
  assert.equal(readFileSync(file, 'utf8'), before, 'a source-less proposal writes no row');

  const rule = 'A builder escalates after two failed attempts.';
  const drafted = await json(box.repo, 'spec', 'draft', rule, '--doctrine', '--source', 'chat, 2026-10-16');
  assert.match(JSON.parse(missing.out).error.message, /source/iu);
  assert.equal(drafted.id, 'doctrine:' + drafted.row.id);
  const row = parseSpec(readFileSync(file, 'utf8')).rows.find(row => row.id === drafted.row.id);
  assert.equal(row.status, 'draft');
  assert.ok(row.text.includes(rule) && row.text.includes('chat, 2026-10-16'), 'the proposed row keeps its source');
  const foreign = await box.inProcess(box.web, 'spec', 'draft', 'A builder cannot propose standing rules.',
    '--doctrine', '--source', 'shout 42', '--json');
  assert.notEqual(foreign.code, 0);
  assert.equal(JSON.parse(foreign.out).error.code, 'COORDINATOR_ONLY');
  for (const path of checkouts) assert.deepEqual((await json(path, 'resume')).doctrineNotes, [], 'draft rulings are not announced');
  const unchanged = readFileSync(file, 'utf8');
  const shell = await runWith(box, box.repo, { CLAUDECODE: '1' }, 'spec', 'approve', drafted.id, '--json');
  assert.notEqual(shell.code, 0, 'an agent shell cannot approve a ruling');
  assert.equal(JSON.parse(shell.out).error.code, 'B26_PERSON_CHANNEL');
  const builder = await box.inProcess(box.web, 'spec', 'approve', drafted.id, '--json');
  assert.notEqual(builder.code, 0, 'a builder worktree cannot approve a ruling');
  assert.match(JSON.parse(builder.out).error.code, /^B26_PERSON/u);
  const viaApi = apiMove(box, box.repo, { verb: 'spec-approve', args: { ids: drafted.id } });
  assert.equal(viaApi.status, 409, JSON.stringify(viaApi));
  assert.equal(viaApi.body.error.code, 'B26_PERSON_CHANNEL', 'the agent API is not the person channel');
  assert.equal(readFileSync(file, 'utf8'), unchanged, 'refused approvals leave the draft alone');
  box.git(box.repo, 'add', 'DOCTRINE.md');
  box.git(box.repo, 'commit', '-q', '-m', 'docs(doctrine): propose ruling');
  for (const path of checkouts) assert.deepEqual((await json(path, 'resume')).doctrineNotes, [], 'a committed draft is not in force either');
  await json(box.repo, 'spec', 'approve', drafted.id);
  for (const path of checkouts) assert.deepEqual((await json(path, 'resume')).doctrineNotes, [], 'pending apply is not in force');
  await json(box.repo, 'spec', 'apply');
  const mainNotes = (await json(box.repo, 'resume')).doctrineNotes;
  assert.equal(mainNotes.length, 1);
  assert.equal(mainNotes[0].id, drafted.id);
  assert.equal(mainNotes[0].text, row.text);
  const text = await box.inProcess(box.web, 'resume');
  assert.equal(text.code, 0, text.err || text.out);
  assert.ok(text.out.includes(`new doctrine ${drafted.id} — ${row.text}`));
  assert.deepEqual((await json(other, 'resume')).doctrineNotes, mainNotes, 'each checkout sees the same approved ruling');
  for (const path of checkouts) assert.deepEqual((await json(path, 'resume')).doctrineNotes, [], 'the notice is consumed only in this checkout');
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), oldHeads[1]);
  assert.equal(box.git(other, 'rev-parse', 'HEAD'), oldHeads[2]);
  assert.ok(!readFileSync(join(box.web, 'DOCTRINE.md'), 'utf8').includes(rule), 'no fixture silently synchronizes the old worktree');

  const item = (await json(box.repo, 'add', 'web', 'Follow the approved ruling', '--route', 'strong', '--specs', drafted.id,
    '--criterion', 'The builder follows the approved ruling.', '--check', 'true')).item;
  await json(box.web, 'claim', String(item.item_id));
  const frozen = JSON.parse((await json(box.web, 'show', String(item.item_id))).item_frozen);
  assert.deepEqual(frozen.rows.map(row => [row.id, row.text]), [[drafted.id, row.text]], 'claim freezes shared approved text');
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), oldHeads[1], 'a doctrine citation does not advance the checkout');
  box.git(box.repo, 'add', 'DOCTRINE.md');
  box.git(box.repo, 'commit', '-q', '-m', `docs(doctrine): approve ruling [${drafted.id}]`);

  const replacement = 'A builder stops after two failed attempts. Source: chat, 2026-10-16';
  await json(box.repo, 'spec', 'approve', drafted.id, '--text', replacement);
  assert.deepEqual((await json(box.web, 'resume', '--diagnostics')).stale, [], 'an unapplied change does not replace the in-force ruling');
  await json(box.repo, 'spec', 'apply');
  const changed = await json(box.web, 'resume', '--diagnostics');
  assert.ok(changed.stale.some(entry => entry.id === item.item_id && entry.rows.includes(drafted.id)), 'the old checkout detects the changed frozen row');
  assert.equal(changed.doctrineNotes[0].text, replacement);
  const again = await json(box.web, 'resume', '--diagnostics');
  assert.deepEqual(again.doctrineNotes, []);
  assert.ok(again.stale.some(entry => entry.id === item.item_id), 'staleness remains after its one-time notice');

  const declined = await json(box.repo, 'spec', 'draft', 'A ruling the person declines.', '--doctrine', '--source', 'shout 42');
  await json(box.repo, 'spec', 'decline', declined.id, '--reason', 'The person declines this proposal.');
  await json(box.repo, 'spec', 'apply');
  assert.ok((await json(other, 'resume')).doctrineNotes.every(note => note.id !== declined.id), 'declined rulings are never announced');

  box.git(box.repo, 'add', 'DOCTRINE.md');
  box.git(box.repo, 'commit', '-q', '-m', `docs(doctrine): revise ruling [${drafted.id}]`);
  const approvedSource = readFileSync(file, 'utf8');
  const retiredSource = approvedSource.replace(`- ${drafted.row.id} [approved, must]`, `- ${drafted.row.id} [retired, must]`);
  assert.notEqual(retiredSource, approvedSource);
  writeFileSync(file, retiredSource);
  box.git(box.repo, 'add', 'DOCTRINE.md');
  box.git(box.repo, 'commit', '-q', '-m', 'docs(doctrine): retire ruling');
  // An old applied receipt must not revive a retired committed rule via an unstaged restoration.
  writeFileSync(file, approvedSource);
  assert.ok((await json(other, 'resume')).doctrineNotes.every(note => note.id !== drafted.id), 'committed retirement wins over a stale receipt and working-copy restoration');
  const retiredItem = (await json(box.repo, 'add', 'web', 'Do not revive the retired ruling', '--route', 'strong', '--specs', drafted.id,
    '--criterion', 'A stale applied receipt cannot revive committed retirement.', '--check', 'true')).item;
  const refused = await box.inProcess(other, 'claim', String(retiredItem.item_id), '--json');
  assert.notEqual(refused.code, 0, 'the stale receipt cannot make a retired rule claimable');
  assert.equal(JSON.parse(refused.out).error.code, 'UNKNOWN_SPEC');
  assert.equal((await json(other, 'show', String(retiredItem.item_id))).item_status, 'open', 'refusal leaves the item unclaimed');
});

test('local doctrine edits flag their frozen row without hiding shared approved rulings [D1,S19,V3]', async (t) => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const oldHead = box.git(box.web, 'rev-parse', 'HEAD');
  /** Exercise the real private CLI and retain its complete successful JSON result. */
  async function json(path, ...args) {
    const result = await box.inProcess(path, ...args, '--json');
    assert.equal(result.code, 0, result.err || result.out);
    return JSON.parse(result.out);
  }
  const drafted = await json(box.repo, 'spec', 'draft', 'Keep shared approved guidance visible.',
    '--doctrine', '--source', 'chat, 2026-10-16');
  box.git(box.repo, 'add', 'DOCTRINE.md');
  box.git(box.repo, 'commit', '-q', '-m', 'docs(doctrine): propose shared guidance');
  await json(box.repo, 'spec', 'approve', drafted.id);
  await json(box.repo, 'spec', 'apply');
  const shared = (await json(box.repo, 'add', 'web', 'Follow shared guidance', '--route', 'strong', '--specs', drafted.id,
    '--criterion', 'Shared approved guidance stays in force.', '--check', 'true')).item;
  const edited = (await json(box.repo, 'add', 'web', 'Follow inherited guidance', '--route', 'strong', '--specs', 'doctrine:PB1',
    '--criterion', 'A changed local row remains visible to diagnostics.', '--check', 'true')).item;
  for (const item of [shared, edited]) {
    await json(box.web, 'claim', String(item.item_id));
    await json(box.web, 'release', String(item.item_id), '--reason', 'BLOCKED');
  }
  const frozen = await Promise.all([shared, edited].map(async item => (await json(box.web, 'show', String(item.item_id))).item_frozen));
  const baseline = await json(box.web, 'resume', '--diagnostics');
  assert.deepEqual(baseline.stale, [], 'unchanged old-checkout files retain the shared approved rule');
  assert.ok(baseline.doctrineNotes.some(note => note.id === drafted.id));
  const file = join(box.web, 'DOCTRINE.md');
  const original = readFileSync(file, 'utf8');
  assert.ok(!original.includes('Keep shared approved guidance visible.'));
  writeFileSync(file, original + '\n## Local diagnostic edit\n- PB1 [approved, must] A changed local inherited rule. | gate: true\n');
  const changed = await json(box.web, 'resume', '--diagnostics');
  assert.deepEqual(changed.stale.map(item => [item.id, item.rows]), [[edited.item_id, ['doctrine:PB1']]],
    'only the locally edited rule is stale; shared approved guidance is still available');
  assert.deepEqual(changed.doctrineNotes, [], 'an unapproved working-copy edit is not announced as new guidance');
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), oldHead, 'diagnostics never advance the old checkout');
  assert.deepEqual(await Promise.all([shared, edited].map(async item => (await json(box.web, 'show', String(item.item_id))).item_frozen)), frozen);
  writeFileSync(file, original);
  assert.deepEqual((await json(box.web, 'resume', '--diagnostics')).stale, [], 'restoring the working file clears only its diagnostic change');
});
