/** The board state the view reads keeps an accept whose only conflict with main is mechanical fresh, and marks a real source conflict stale naming the file [C7,#3064]. @pullboard-test-input source-cell store */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';
import { loadStopRules } from '../../../../items/index.js';
import { buildLocalBoardState } from '../../../src/io/board/state.js';
import { mechanicalConflictFiles } from '../../../src/io/board.js';
import { ENGINE_VERSION } from '../../../../state/index.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellItem } from '../../fixtures/cell.js';
import { cellSeat } from '../../fixtures/cell.js';
import { temporaryRepository } from '../../fixtures/submit.js';

const POLICY = { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } };
const PROOF = { version: 1, files: [], full: false, deferred: true, reason: 'synthetic board-state fixture; no gate execution' };
const TEXT = Array.from({ length: 10 }, (_, index) => `a line ${index}`);

/** Run git in a directory and return trimmed output. */
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

/** Write both files on the current branch and commit them; `json` names the extra key, `line` replaces line two of a.txt. */
function commitFiles(dir, { json, line }) {
  writeFileSync(join(dir, 'data.json'), `{\n  "keep": 0${json ? `,\n  "${json}": 1` : ''}\n}\n`);
  const lines = [...TEXT];
  if (line) lines[2] = line;
  writeFileSync(join(dir, 'a.txt'), `${lines.join('\n')}\n`);
  git(dir, 'add', 'data.json', 'a.txt');
  git(dir, 'commit', '-q', '-m', `files ${json ?? line ?? 'base'}`);
  return git(dir, 'rev-parse', 'HEAD');
}

/** The explicit upper presentation ports a state build needs, reduced to what an item's verdict state reads. */
const PORTS = {
  openBoard: () => null,
  verifiedPasskeyRowDecision: () => null,
  pendingFit: () => ({}),
  projectFit: (_pending, state) => state,
  projectState: (_root, { board, itemProjector }) => ({ agents: [], spec: [], practice: [],
    items: store.listItems(board, { all: true }).map(item => itemProjector(item, { project: () => ({ id: item.item_id, status: item.item_status, history: [], verdicts: [], merged: false }) })) }),
  personRequestStatuses: () => [],
  personSigningPresentation: () => ({}),
  activeViewAgents: agents => agents,
  viewProofSummary: summary => summary,
  claimHealthSnapshot: () => new Map(),
};

/** A real repository where two reviewed branches both conflict with main, a real board holding each as a verified item, and the built state. */
function built(t) {
  const repo = temporaryRepository(t, 'pullboard-state-mechanical-');
  const base = commitFiles(repo, {});
  git(repo, 'checkout', '-q', '-b', 'mechanical');
  const mechanicalHead = commitFiles(repo, { json: 'item' });
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'checkout', '-q', '-b', 'source');
  const sourceHead = commitFiles(repo, { line: 'item line two' });
  git(repo, 'checkout', '-q', 'main');
  const tip = commitFiles(repo, { json: 'main', line: 'main line two' });
  mkdirSync(join(repo, '.git', 'pullboard'), { recursive: true });
  const board = cellBoard(t, join(repo, '.git', 'pullboard', 'board.sqlite'), { now: () => new Date() }, { real: true, gitRoot: repo });
  cellSeat(board, { lane: 'coordinator', path: '/repo' });
  const builder = cellSeat(board, { lane: 'core', path: '/builder', family: 'State Builder Vendor', route: 'mid' });
  const reviewer = cellSeat(board, { lane: 'review', path: '/reviewer', family: 'State Reviewer Vendor', route: 'strong' });
  const verified = (title, head, paths) => {
    const id = cellItem(board, { lane: 'core', title, criterion: 'one', route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves it' }).item_id;
    const freeze = item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: { ...POLICY, commit: head } }), digest: 'digest:state' });
    store.claim(board, id, { agentId: builder.id, lane: 'core', leaseMs: 7_200_000, freeze });
    const tree = git(repo, 'rev-parse', `${head}^{tree}`);
    board.executionEngineVersion = undefined; // the submit of an earlier item left the verify engine on
    store.writeBoardCommand(board, 'submit', [id, { agentId: builder.id, commit: head, tree, submissionProof: PROOF }], builder.id);
    board.executionEngineVersion = ENGINE_VERSION;
    const item = store.getItem(board, id);
    store.writeBoardCommand(board, 'verify', [id, { agentId: reviewer.id, decision: 'ACCEPT', head, digest: item.item_frozen_digest, policy: 'any', familyPolicy: 'off',
      note: 'Synthetic fixture accept: read the diff against the bar.', review: { commit: head, head, trunk: base, paths } }], reviewer.id);
    return id;
  };
  const mechanical = verified('mechanical conflict only', mechanicalHead, ['data.json']);
  const source = verified('real source conflict', sourceHead, ['a.txt']);
  const state = buildLocalBoardState(repo, 'main', board, true, { observedAt: Date.now() }, PORTS).state;
  return { repo, tip, mechanicalHead, sourceHead, mechanical: state.items.find(item => item.id === mechanical), source: state.items.find(item => item.id === source) };
}

test('store.io-board-state.mechanical-conflict-keeps-the-accept-fresh: clause 1: buildLocalBoardState marks an accepted item whose only conflict with main is mechanical as fresh, and one with a real source conflict as stale naming the file [C7,#3064]', t => {
  const { mechanical, source } = built(t);
  assert.ok(mechanical, 'the mechanical item is in the built state');
  assert.equal(mechanical.verdictState, undefined, 'a conflict the mechanical merge resolves leaves the accept fresh');
  assert.equal(source.verdictState?.code, 'STALE_VERDICT', 'a real source conflict leaves the accept stale');
  assert.equal(source.verdictState.file, 'a.txt', 'the stale state names the conflicting file');
});

test('store.io-board-state.production-wiring: clause 2: the state build reaches the mechanical-conflict reader through the board front door, which names only the file a mechanical merge cannot resolve [C7,#3064]', t => {
  const { repo, tip, mechanicalHead, sourceHead, mechanical } = built(t);
  assert.equal(typeof mechanicalConflictFiles, 'function', 'the board front door exports the reader');
  assert.deepEqual(mechanicalConflictFiles(repo, tip, mechanicalHead), [], 'the reader resolves the mechanical conflict');
  assert.deepEqual(mechanicalConflictFiles(repo, tip, sourceHead), ['a.txt'], 'the reader names the real source conflict');
  assert.equal(mechanical.verdictState, undefined, 'the state build used that reader, so the mechanical item stayed fresh');
});

/** A real board with a coordinator and three open items: one rejected twice and refused once (a wall), one rejected once (rework), one untouched. */
function judgementBoard(t) {
  const repo = temporaryRepository(t, 'pullboard-state-judgement-');
  mkdirSync(join(repo, '.git', 'pullboard'), { recursive: true });
  const board = cellBoard(t, join(repo, '.git', 'pullboard', 'board.sqlite'), { now: () => new Date() }, { real: true, gitRoot: repo });
  cellSeat(board, { lane: 'coordinator', path: '/repo' });
  const file = title => cellItem(board, { lane: 'web', title, criterion: 'one', route: 'mid', check: 'true', brief: 'Files: web/a.js\nTest: proves it' }).item_id;
  const [wall, rework, untouched] = [file('Walled item'), file('Reworked item'), file('Untouched item')];
  const move = (id, kind, detail) => board.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), 'fixture-seat', kind, id, JSON.stringify(detail));
  move(wall, 'reject', { clause: 1, note: 'first reject' });
  move(wall, 'reject', { clause: 1, note: 'second reject' });
  move(wall, 'release', { reasonCode: 'INELIGIBLE', note: 'cannot be built as written' });
  move(rework, 'reject', { clause: 1, note: 'only reject' });
  return { repo, board, wall, rework, untouched };
}

/** The state a build gives the board while the machine settings are `settings`, with or without the stop rules passed in. */
async function judgementState(box, settings, withRules) {
  const home = join(box.repo, 'machine-home');
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, settings);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  try {
    const stopRules = withRules ? await loadStopRules() : undefined;
    return buildLocalBoardState(box.repo, 'main', box.board, true, { observedAt: Date.now(), stopRules }, PORTS).state;
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('store.io-board-state.needs-judgement-listed: clause 1: with next.returnedFirst on and the stop rules passed in, the state carries needsJudgement with one entry for the walled item (reason, latest refusal text, 3 attempts) and none for a reworked or untouched item [C7,#11668]', async t => {
  const box = judgementBoard(t);
  const state = await judgementState(box, { next: { returnedFirst: true } }, true);
  assert.deepEqual(state.needsJudgement, [{ id: box.wall, reason: 'wall', refusalText: 'cannot be built as written', attempts: 3 }]);
});

test('store.io-board-state.needs-judgement-off: clause 2: with next.returnedFirst off or unset, or with no stop rules passed, the state carries no needsJudgement key [C7,#11668]', async t => {
  const box = judgementBoard(t);
  assert.equal('needsJudgement' in await judgementState(box, { next: { returnedFirst: false } }, true), false);
  assert.equal('needsJudgement' in await judgementState(box, {}, true), false);
  assert.equal('needsJudgement' in await judgementState(box, { next: { returnedFirst: true } }, false), false);
});
