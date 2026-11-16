import { viewApiPorts } from '../../../view/index.js';
import { apiBoardOpeners } from '../../tests/fixtures/board.js';
import { nativeBoardPorts as relayPresentationNativePorts } from '../../../lib/index.js';
/** A refusal that stops someone reaches whoever can clear it, is recorded, and repeats are counted [C6,N26]. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { serveApi } from '../../../../packages/api/index.js';
import { refusalDocument } from '../../index.js';
import { repoInfo } from '../../../../packages/git/index.js';
import { personNeedsState } from '../../../view/index.js';
import {
  BLOCK_AUDIENCE,
  NEXT_STEPS,
  blockAudience,
  reportBlock,
} from '../../index.js';
import { Refused } from '../../../../packages/kernel/light.js';
import {
  personBlockWords,
  readBlocks,
  readLedgerBytes,
} from '../../../../packages/items/index.js';
import { relayPresentation } from '../../../../packages/pages/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';

/** Bind the real canonical presentation providers once for this fixture module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('a block clears when its audience completes the same move [C6,N26]', async t => {
  const box = e2e.project();
  const ask = async text => {
    const result = await box.runLocal(box.repo, 'shout', 'person', text, '--decision', '--json');
    assert.equal(result.code, 0, `${result.err}\n${result.out}`);
    return JSON.parse(result.out).id;
  };
  const first = await ask('First choice?');
  const second = await ask('Another choice?');
  const info = repoInfo(box.repo);
  box.env.CLAUDECODE = '1';
  const blocked = await box.runLocal(box.repo, 'answer', String(first), 'yes', '--as', 'person');
  assert.equal(blocked.code, 1, blocked.err);
  const needs = () => personNeedsState(box.repo).needs.filter(row => row.kind === 'block');
  assert.equal(needs().length, 1, 'the stopped person move appears in Needs you');
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, secret: 'blocks-test', runCommand: async () => 0, isMain: true,
    projects: () => [{ root: box.repo, name: 'blocks-clear', project: '', added: '2026-10-22T00:00:00.000Z' }] });
  t.after(() => api.close());
  assert.equal((await apiNeeds(api, box.repo)).blocks.length, 1, 'the API caches the initial block');
  const wrongActor = await box.runLocal(box.repo, 'answer', String(first), 'agent answer');
  assert.equal(wrongActor.code, 1, wrongActor.err);
  assert.ok(readBlocks(info.commonDir).some(block => block.owner === 'coordinator'),
    'the refused default answer leaves a coordinator-audience block');
  assert.ok(needs().length > 0, 'a different actor cannot clear the person move');
  delete box.env.CLAUDECODE;
  for (const option of ['--help', '--version']) {
    const informational = await box.runLocal(box.repo, 'answer', String(first), option);
    assert.equal(informational.code, 0, informational.err);
    assert.ok(needs().length > 0, `${option} does not complete the stopped move`);
  }
  const other = await box.runLocal(box.repo, 'answer', String(second), 'yes', '--as', 'person');
  assert.equal(other.code, 0, other.err);
  assert.ok(needs().length > 0, 'success on another item leaves the first block');
  const completed = await box.runLocal(box.repo, 'answer', String(first), 'yes', '--as', 'person');
  assert.equal(completed.code, 0, completed.err);
  assert.deepEqual(needs(), [], 'the matching completed move clears Needs you at once');
  assert.deepEqual((await apiNeeds(api, box.repo)).blocks, [], 'the clear invalidates the cached API projection');
  const health = JSON.parse((await box.runLocal(box.repo, 'health', '--json')).out);
  assert.deepEqual(health.blocks.codes, [], 'health no longer counts resolved blocks');
  assert.deepEqual(readBlocks(info.commonDir), [], 'the active ledger view excludes explicit clears');

  const waiting = await ask('Still waiting?');
  box.env.CLAUDECODE = '1';
  assert.equal((await box.runLocal(box.repo, 'answer', String(waiting), 'yes', '--as', 'person')).code, 1);
  delete box.env.CLAUDECODE;
  assert.equal(personBlockWords(info.commonDir, new Date()).length, 1, 'an unmatched block remains');
  assert.equal(personBlockWords(info.commonDir, new Date(Date.now() + 86_400_001)).length, 0,
    'an unmatched block still expires after 24 hours');

  const specBox = e2e.project();
  const specInfo = repoInfo(specBox.repo);
  specBox.env.CLAUDECODE = '1';
  const blockedSet = await specBox.runLocal(specBox.repo, 'spec', 'approve', 'G1,G2');
  assert.equal(blockedSet.code, 1, blockedSet.err);
  delete specBox.env.CLAUDECODE;
  assert.equal(readBlocks(specInfo.commonDir).length, 1, 'the two-row approval is one stopped move');
  const firstRow = await specBox.runLocal(specBox.repo, 'spec', 'approve', 'G1');
  assert.equal(firstRow.code, 0, `${firstRow.err}\n${firstRow.out}`);
  assert.equal(readBlocks(specInfo.commonDir).length, 1, 'one completed target leaves the other pending');
  const secondRow = await specBox.runLocal(specBox.repo, 'spec', 'approve', 'G2');
  assert.equal(secondRow.code, 0, `${secondRow.err}\n${secondRow.out}`);
  assert.deepEqual(readBlocks(specInfo.commonDir), [], 'separate later successes complete the blocked set');

  const milestones = e2e.project();
  const milestoneInfo = repoInfo(milestones.repo);
  for (const name of ['First release', 'Second release']) {
    const added = await milestones.runLocal(milestones.repo, 'milestone', 'add', name);
    assert.equal(added.code, 0, `${added.err}\n${added.out}`);
  }
  const stopped = await milestones.runLocal(milestones.repo, 'milestone', 'edit', 'First release', '--target', 'not-a-date');
  assert.equal(stopped.code, 1, stopped.err);
  assert.equal(readBlocks(milestoneInfo.commonDir).length, 1, 'the named milestone edit is blocked');
  const different = await milestones.runLocal(milestones.repo, 'milestone', 'edit', 'Second release', '--note', 'Updated');
  assert.equal(different.code, 0, `${different.err}\n${different.out}`);
  assert.equal(readBlocks(milestoneInfo.commonDir).length, 1, 'editing a different named milestone leaves the block');
  const same = await milestones.runLocal(milestones.repo, 'milestone', 'edit', 'First release', '--note', 'Updated');
  assert.equal(same.code, 0, `${same.err}\n${same.out}`);
  assert.deepEqual(readBlocks(milestoneInfo.commonDir), [], 'the matching named milestone success clears it');
});

test('a successful edit clears only its own item [C6]', async () => {
  const box = e2e.project();
  const add = async title => {
    const result = await fixtureAdd(box.runLocal, box.repo, 'web', title, '--json');
    assert.equal(result.code, 0, `${result.err}\n${result.out}`);
    return JSON.parse(result.out).item.item_id;
  };
  const first = await add('First item');
  const second = await add('Second item');
  const info = repoInfo(box.repo);
  const blocked = await box.runLocal(box.repo, 'edit', String(second), '--route', 'not-a-route');
  assert.equal(blocked.code, 1, blocked.err);
  const before = readBlocks(info.commonDir);
  assert.equal(before.length, 1, 'the refused edit is recorded');
  const unrelated = await box.runLocal(box.repo, 'edit', String(first), '--brief', 'First updated');
  assert.equal(unrelated.code, 0, unrelated.err);
  assert.equal(readBlocks(info.commonDir).length, 1, 'editing another item leaves the blocked edit');
  const completed = await box.runLocal(box.repo, 'edit', `#${second}`, '--brief', 'Second updated');
  assert.equal(completed.code, 0, completed.err);
  assert.deepEqual(readBlocks(info.commonDir), [], 'the same item clears across its accepted #id spelling');
});

/** Needs you as the local API serves it, read in full so every person call is present. */
async function apiNeeds(api, root) {
  const headers = { 'x-pullboard-key': 'blocks-test' };
  const listing = await (await fetch(api.url)).json();
  const id = listing.boards.find(board => board.root === root).id;
  const { state } = await (await fetch(`http://127.0.0.1:${api.port}/api/v1/boards/${id}/state?detail=full`, { headers })).json();
  return { needs: state.needs.filter(row => row.kind === 'block'), blocks: state.blocks };
}

test('a Pullboard block reaches whoever can clear it and repeats are counted [C6,N26]', {
  timeout: 240_000, // budget: about 60 real CLI subprocess spawns on a loaded runner (89 s green, 174 s red at load 19), never a hang allowance.
}, async (t) => {
  const box = e2e.project();

  // A person-only move from an agent's terminal: the person, not the agent, can clear it.
  box.env.CLAUDECODE = '1';
  const person = await box.runLocal(box.repo, 'answer', '1', 'yes', '--as', 'person');
  delete box.env.CLAUDECODE;
  assert.equal(person.code, 1, person.err);
  assert.match(person.err, /^pullboard: only the person can clear this; it is in their Needs you list now$/mu);
  const needs = personNeedsState(box.repo).needs.filter(row => row.kind === 'block');
  assert.equal(needs.length, 1, JSON.stringify(needs));
  assert.equal(needs[0].text, 'Pullboard stopped a request that only you can clear: this terminal belongs to an agent');
  assert.match(needs[0].what, /^run pullboard view\b/u);
  assert.doesNotMatch(`${needs[0].text} ${needs[0].what}`, /\[[A-Z][A-Z0-9_]*\]|B26|relay|--/u);

  // The local API and the sealed relay page build Needs you from the same ledger, without local paths.
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, secret: 'blocks-test', runCommand: async () => 0, isMain: true,
    projects: () => [{ root: box.repo, name: 'blocks', project: '', added: '2026-10-22T00:00:00.000Z' }] });
  t.after(() => api.close());
  assert.deepEqual((await apiNeeds(api, box.repo)).needs.map(row => row.text), [needs[0].text]);

  // The relay's person-only refusals, as relay.js and relay-seats.js raise them, are the person's too;
  // a seat's own expired token is the coordinator's.
  const said = [];
  const io = { callerRole: () => 'coordinator', err: line => said.push(line) };
  const info = repoInfo(box.repo);
  const raise = (error, command) => reportBlock(io, error, { command, info, now: new Date() });
  assert.equal(raise(new Refused('HUMAN_REQUIRED', 'send this person action from the paired phone'), 'answer').audience, 'person');
  assert.equal(raise(new Refused('TOKEN_EXPIRED', 'the coordinator relay token expired; the person reissues it: run pullboard relay on in the main checkout'), 'shout').audience, 'person');
  assert.equal(raise(new Refused('TOKEN_EXPIRED', 'the relay token of web-1 expired, and only a seat\'s own current token or its creator renews it; ask the coordinator for a fresh worktree: pullboard worktree <lane> --model "<model name>"'), 'claim').audience, 'coordinator');
  assert.equal(said.filter(line => /only the person can clear this/u.test(line)).length, 2);
  // A refusal outside the table stays the agent's, whatever its wording says about the person.
  assert.equal(blockAudience('RATCHET_ROSE', 'C9 rose to 54, was 53; fix the new problems, commit, and submit again; only the person can sign an increased count'), 'agent');
  const personRows = personNeedsState(box.repo).needs.filter(row => row.kind === 'block');
  assert.deepEqual(personRows.map(row => row.text).sort(), [
    'Pullboard stopped a request that only you can clear: send this person action from the paired phone',
    'Pullboard stopped a request that only you can clear: this terminal belongs to an agent',
    'Pullboard stopped a request that only you can clear: your sign-in for the coordinator expired; the person reissues it',
  ]);
  for (const row of personRows) assert.doesNotMatch(row.text, /\[[A-Z][A-Z0-9_]*\]|relay|_/u);
  // The API sees the new blocks at once (the ledger invalidates its cached state), and so does the relay page.
  const served = await apiNeeds(api, box.repo);
  assert.deepEqual(served.needs.map(row => row.text).sort(), personRows.map(row => row.text).sort());
  assert.ok(served.blocks.every(block => block.audience === 'person' && !('path' in block)), JSON.stringify(served.blocks));
  const sealed = relayPresentation(box.repo, {}, RELAY_PRESENTATION_PORTS).state;
  assert.deepEqual(sealed.needs.filter(row => row.kind === 'block').map(row => row.text).sort(), personRows.map(row => row.text).sort());
  assert.ok(sealed.blocks.every(block => !('path' in block)), JSON.stringify(sealed.blocks));

  // An agent's coordinator-only move: the agent is told to take it to the coordinator.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const held = await box.runLocal(box.web, 'hold', 'api', '--reason', 'the api lane waits');
    assert.equal(held.code, 1, held.err);
    assert.match(held.err, /\[COORDINATOR_ONLY\]/u);
    assert.match(held.err, /^pullboard: only the coordinator can clear this; tell them: pullboard shout coordinator --kind blocker "blocked by COORDINATOR_ONLY on pullboard hold: only the coordinator holds a lane"$/mu);
  }
  // An agent's block is not the person's call.
  assert.equal(personNeedsState(box.repo).needs.filter(row => row.kind === 'block').length, 3);

  // Health counts the day's blocks by code and drafts an item for the one that repeated.
  const report = JSON.parse((await box.runLocal(box.repo, 'health', '--json')).out);
  const byCode = Object.fromEntries(report.blocks.codes.map(entry => [entry.code, entry]));
  assert.equal(byCode.COORDINATOR_ONLY.count, 3);
  assert.deepEqual(byCode.COORDINATOR_ONLY.commands, ['pullboard hold']);
  assert.deepEqual(byCode.COORDINATOR_ONLY.who, ['web-1']);
  assert.equal(byCode.COORDINATOR_ONLY.audience, 'coordinator');
  assert.equal(byCode.B26_PERSON_CHANNEL.count, 1);
  assert.deepEqual(byCode.B26_PERSON_CHANNEL.who, ['coordinator']);
  assert.equal(byCode.HUMAN_REQUIRED.count, 1);
  assert.equal(byCode.TOKEN_EXPIRED.count, 2);
  assert.deepEqual(report.blocks.drafts.map(draft => draft.cause), ['refusal:COORDINATOR_ONLY', 'refusal:TOKEN_EXPIRED']);
  const [draft] = report.blocks.drafts;
  assert.equal(draft.title, 'Pullboard blocked 3 requests in a day with COORDINATOR_ONLY');
  const text = (await box.runLocal(box.repo, 'health', '--detail')).out;
  assert.match(text, /^ {2}COORDINATOR_ONLY 3x on pullboard hold, stopped web-1; the coordinator clears it: ask the coordinator/mu);
  assert.match(text, /^ {2}repeated, draft an item: pullboard add coordinator 'Pullboard blocked 3 requests in a day with COORDINATOR_ONLY'/mu);

  // The drafted item files as it reads.
  const added = await fixtureAdd(box.runLocal, box.repo, draft.lane, draft.title, '--brief', draft.brief, '--json');
  assert.equal(added.code, 0, added.err);
  assert.equal(JSON.parse(added.out).item.item_title, draft.title);

  // Every person-only code in the catalog lands in Needs you, B26_PERSON_APPROVAL with its real words.
  const personCodes = Object.keys(BLOCK_AUDIENCE).filter(code => BLOCK_AUDIENCE[code] === 'person');
  assert.ok(personCodes.includes('B26_PERSON_APPROVAL'));
  for (const code of Object.keys(NEXT_STEPS).filter(code => /PERSON_ONLY$/u.test(code))) assert.equal(BLOCK_AUDIENCE[code], 'person', code);
  for (const code of personCodes) {
    assert.ok(NEXT_STEPS[code], `${code} has a step in the catalog`);
    const words = code === 'B26_PERSON_APPROVAL'
      ? 'only the person from the main checkout approves or declines a spec row; use pullboard view for the person to decide'
      : `the ${code.toLowerCase().replaceAll('_', ' ')} rule stops this`;
    assert.equal(raise(new Refused(code, words), `sweep ${code.toLowerCase()}`).audience, 'person', code);
  }
  const swept = new Set(personNeedsState(box.repo).needs.filter(row => row.kind === 'block' && row.id.includes(' pullboard sweep ')).map(row => row.id.split(' ')[0].slice('block:'.length)));
  assert.deepEqual([...swept].sort(), [...personCodes].sort());
  assert.ok((await apiNeeds(api, box.repo)).needs.some(row => row.id.startsWith('block:B26_PERSON_APPROVAL ')));
});

test('clause 1: readBlocks with a since bound parses no line older than the bound and reads a 20 MB ledger in under 20 ms [C7]', t => {
  const commonDir = privateFixtureFiles('pullboard-blocks-tail-').root;
  t.after(() => fs.rmSync(commonDir, { recursive: true, force: true }));
  fs.mkdirSync(join(commonDir, 'pullboard'));
  const now = Date.parse('2026-11-06T12:00:00Z'), line = (i, at, extra = {}) => JSON.stringify({ at: new Date(at).toISOString(), code: 'B1', id: `b${i}`, command: 'x'.repeat(180), ...extra });
  const old = [];
  for (let i = 0; i < 90_000; i++) old.push(line(i, now - 3 * 86_400_000 + i));
  const recent = [line('r1', now - 3_600_000), line('r2', now - 1_800_000), JSON.stringify({ kind: 'clear', ids: ['br1'] }), line('r3', now - 60_000)];
  const file = join(commonDir, 'pullboard', 'blocks.jsonl');
  fs.writeFileSync(file, [...old, ...recent].join('\n') + '\n');
  assert.ok(fs.statSync(file).size > 20_000_000, 'the ledger is 20 MB');
  const since = new Date(now - 86_400_000), parse = JSON.parse; let parsed = 0, best = Infinity, blocks;
  let oldParsed = 0;
  JSON.parse = function(...args) { parsed++; if (/"id":"b\d/u.test(String(args[0]))) oldParsed++; return parse.apply(this, args); };
  try {
    for (let run = 0; run < 5; run++) {
      parsed = 0;
      const begun = process.hrtime.bigint();
      blocks = readBlocks(commonDir, { since });
      best = Math.min(best, Number(process.hrtime.bigint() - begun) / 1e6);
    }
  } finally { JSON.parse = parse; }
  assert.deepEqual(blocks.map(block => block.id), ['br2', 'br3'], 'recent blocks survive and the cleared one is gone');
  assert.equal(oldParsed, 0, 'no line older than the bound was parsed');
  assert.ok(parsed < 5_000, `only the tail was parsed, not ${parsed} lines`);
  assert.ok(best < 20, `a 20 MB ledger read in ${best.toFixed(1)} ms`);
  assert.equal(readBlocks(commonDir).length, 90_002, 'no bound still reads the whole ledger');
});

test('clause 1: a ledger that names none of a completed move\'s keys is never parsed, and one that names a key reads as before [C7]', t => {
  const commonDir = privateFixtureFiles('pullboard-blocks-mention-').root;
  t.after(() => fs.rmSync(commonDir, { recursive: true, force: true }));
  fs.mkdirSync(join(commonDir, 'pullboard'));
  const lines = [];
  for (let i = 0; i < 20_000; i++) lines.push(JSON.stringify({ at: '2026-11-09T00:00:00.000Z', code: 'B1', id: `b${i}`, moveKey: `${'a'.repeat(63)}${i % 10}` }));
  fs.writeFileSync(join(commonDir, 'pullboard', 'blocks.jsonl'), lines.join('\n') + '\n');
  const parse = JSON.parse; let parsed = 0;
  JSON.parse = function(...args) { parsed++; return parse.apply(this, args); };
  let absent;
  try { absent = readBlocks(commonDir, { mentioning: ['f'.repeat(64)] }); } finally { JSON.parse = parse; }
  assert.deepEqual(absent, []);
  assert.equal(parsed, 0, 'no ledger line was parsed for a key it does not hold');
  const key = `${'a'.repeat(63)}3`;
  // A clear of one named block must still remove it, so clears are read too.
  fs.appendFileSync(join(commonDir, 'pullboard', 'blocks.jsonl'), JSON.stringify({ kind: 'clear', at: '2026-11-09T00:00:01.000Z', ids: ['b3'] }) + '\n');
  parsed = 0;
  JSON.parse = function(...args) { parsed++; return parse.apply(this, args); };
  let named;
  try { named = readBlocks(commonDir, { mentioning: [key] }); } finally { JSON.parse = parse; }
  assert.deepEqual(named, readBlocks(commonDir).filter(block => block.moveKey === key), 'the blocks naming the key, as an unfiltered read gives them');
  assert.ok(!named.some(block => block.id === 'b3'), 'the cleared block stays cleared');
  assert.equal(parsed, 2_001, 'only the lines naming the key and the clear were parsed');
});

/** A ledger over the first 256 KB read window whose blocks name one of ten move keys, plus a clear of one; returns its folder and a key. */
function largeLedger(t) {
  const commonDir = privateFixtureFiles('pullboard-blocks-once-').root;
  t.after(() => fs.rmSync(commonDir, { recursive: true, force: true }));
  fs.mkdirSync(join(commonDir, 'pullboard'));
  const lines = [];
  for (let i = 0; i < 4_000; i++) lines.push(JSON.stringify({ at: '2026-11-09T00:00:00.000Z', code: 'B1', id: `b${i}`, moveKey: `${'c'.repeat(63)}${i % 10}`, command: 'x'.repeat(40) }));
  lines.push(JSON.stringify({ kind: 'clear', at: '2026-11-09T00:00:01.000Z', ids: ['b7'] }));
  const file = join(commonDir, 'pullboard', 'blocks.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  assert.ok(fs.statSync(file).size > 262_144, 'the ledger is larger than the first read window');
  return { commonDir, key: `${'c'.repeat(63)}7` };
}

test('clause 1: readBlocks with mentioning returns the same blocks for a ledger over 256 KB as a read that walks the windows from the end [C7]', t => {
  const { commonDir, key } = largeLedger(t);
  const once = readBlocks(commonDir, { mentioning: [key] });
  assert.equal(once.length, 399, 'the 400 blocks naming the key, less the cleared one');
  assert.deepEqual(once, readBlocks(commonDir, { mentioning: [key], since: new Date(0) }));
  assert.deepEqual(readBlocks(commonDir, { mentioning: ['f'.repeat(64)] }), []);
});

test('clause 2: readBlocks with mentioning and no since reads the ledger file once [C7]', t => {
  const { commonDir, key } = largeLedger(t);
  let reads = 0;
  const read = (file, offset) => { reads += 1; return readLedgerBytes(file, offset); };
  readBlocks(commonDir, { mentioning: [key], read });
  assert.equal(reads, 1, 'one read of the whole ledger');
  reads = 0;
  readBlocks(commonDir, { mentioning: ['f'.repeat(64)], read });
  assert.equal(reads, 1, 'a ledger naming no key is read once and never decoded');
});
