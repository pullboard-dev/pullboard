// pullboard: browser
/** @pullboard-test-gui */
/** Public exports keep public prose and refuse private data before writing [N26]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { withPrivateBoard } from '../../../../packages/seats/index.js';
import { atomic } from '../../../../packages/store/index.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { finishLandingBatch } from '../../../../packages/store/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { landingBatches } from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { recordLandingBatch } from '../../../../packages/store/index.js';
import { addItem } from '../../../../packages/store/index.js';
import { board_ensureCoordinator as ensureCoordinator } from '../../../../packages/store/index.js';
import { PUBLIC_EXPORT_BLOCKS } from '../../../view/index.js';
import { publicSnapshot } from '../../../view/index.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { BIN } from '../../tests/fixtures/cockpit/harness.js';
import { accept } from '../../tests/fixtures/cockpit/harness.js';
import { build } from '../../tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { project } from '../../tests/fixtures/cockpit/harness.js';
import { serveFolder } from '../../tests/fixtures/cockpit/harness.js';

const BLOCKED = [
  ['machine or host name', '192.168.4.5'], ['machine or host name', 'test-host.local'],
  ['machine or host name', 'a5x'], ['machine or host name', ['stu', 'dio'].join('')],
  ['machine or host name', ['Mac', 'Book'].join('')], ['machine or host name', 'tester@host'],
  ['email', 'tester@example.invalid'], ['secret-shaped string', 'sk-fixtureonly12345678'],
  ['secret-shaped string', 'a'.repeat(64)], ['secret-shaped string', 'YWJj'.repeat(12)],
  ['secret-shaped string', 'token=fixtureonly12345678'],
  ...['$42', 'per month', '/month', 'pricing', 'price of', 'subscription price', 'acquisition', 'valuation'].map(text => ['pricing term', text]),
];

/** Run the genuine CLI so the public switch and export writer are exercised together. */
function command(box, root, ...args) {
  return runFixtureChild(process.execPath, [BIN, ...args, '--json'], { cwd: root, env: box.env, encoding: 'utf8' });
}

test('the declared public filter blocks every ruled kind without echoing its value [N26]', () => {
  assert.deepEqual(PUBLIC_EXPORT_BLOCKS.text.map(([kind]) => kind), ['machine or host name', 'email', 'secret-shaped string', 'pricing term', 'home path', 'chat or agent session id']);
  const labels = new Set(PUBLIC_EXPORT_BLOCKS.text.map(([kind]) => kind));
  for (const [kind, text] of BLOCKED) {
    assert.throws(() => publicSnapshot({ brief: text }), error => error.code === 'PUBLIC_EXPORT_BLOCKED'
      && error.message.includes(kind) && error.message.split(': ').at(-1).split(', ').every(label => labels.has(label)), kind);
  }
  assert.throws(() => publicSnapshot({ items: [{ title: 'Private fixture work' }] }, { privateBoard: true }), /private item/u);
  const native = { listing: { boards: [{ id: 'd'.repeat(32) }] }, state: { state: { board: 'd'.repeat(32), rowAgesAt: { 'SPEC.md': 'a'.repeat(40) },
    items: [{ id: 1, commit: 'a'.repeat(40), merged: 'b'.repeat(40) }] } },
    events: { events: [{ event_kind: 'submit', event_detail: JSON.stringify({ commit: 'a'.repeat(40), tree: 'b'.repeat(40), criterionDigest: 'c'.repeat(64),
      submissionSize: { base: 'b'.repeat(40), head: 'a'.repeat(40), lines: 1, method: 'added-plus-deleted-no-renames' } }) }] } };
  assert.deepEqual(publicSnapshot(native), native, 'only native paths with exact identifier widths are exempt');
  const receipt = { id: '018fc314-57c9-7318-a11f-55a08a28a101', commit: 'a'.repeat(40), tree: 'b'.repeat(64), frozenDigest: 'c'.repeat(64) };
  const proofs = { state: { state: { items: [{ thread: [{ kind: 'proof-run', detail: { receipt } }] }],
    events: [{ event_kind: 'proof-run', event_detail: JSON.stringify({ receipt }) }] } },
    events: { events: [{ event_kind: 'proof-run', event_detail: JSON.stringify({ receipt }) }] } };
  assert.deepEqual(publicSnapshot(proofs), proofs, 'native receipt hashes qualify in all three history projections');
  for (const forged of [{ customer_id: 'a'.repeat(64) }, { note_id: 'a'.repeat(64) }, { commit: 'a'.repeat(40) },
    { events: { events: [{ event_kind: 'fact', event_detail: JSON.stringify({ note_id: 'a'.repeat(64), commit: 'b'.repeat(40) }) }] } },
    { state: { state: { rowAgesAt: { 'SPEC.md': 'a'.repeat(64) } } } },
    { personRequests: [{ text: 'a'.repeat(64) }] }, { kind: 'decision', text: 'a'.repeat(64) },
    { receipt }, { events: { events: [{ event_kind: 'fact', event_detail: JSON.stringify({ receipt }) }] } },
    { events: { events: [{ event_kind: 'proof-run', event_detail: JSON.stringify({ receipt: { commit: 'a'.repeat(32) } }) }] } },
    { events: { events: [{ event_kind: 'proof-run', event_detail: JSON.stringify({ receipt: { note_id: 'a'.repeat(64) } }) }] } }]) {
    assert.throws(() => publicSnapshot(forged), /secret-shaped string/u, 'arbitrary keys and wrong native shapes stay checked');
  }
  assert.throws(() => publicSnapshot({ commit: 'sk-fixtureonly12345678' }), /secret-shaped string/u, 'an identity key does not exempt an arbitrary credential');
  assert.deepEqual(publicSnapshot({ title: 'A private implementation detail', reviewPolicy: { sensitive: true }, brief: 'A sale client connects.' }),
    { title: 'A private implementation detail', reviewPolicy: { sensitive: true }, brief: 'A sale client connects.' }, 'review sensitivity and ordinary technical words are not privacy flags');
  const privateKey = 'arbitrary-user-supplied-name';
  assert.throws(() => publicSnapshot({ state: { state: { items: [{ [privateKey]: 'sk-fixtureonly12345678' }] } } }), error =>
    error.next.includes('state.state.items.*.[field]') && !error.next.includes(privateKey) && !error.next.includes('fixtureonly'),
  'diagnostics expose only allowlisted schema names and a category');
});

test('native Dashboard landing commits keep their exact public identity shape [N26]', () => {
  for (const width of [40, 64]) {
    const native = { state: { state: { dashboardLanded: [{ id: 1, commit: 'a'.repeat(width) }] } } };
    assert.deepEqual(publicSnapshot(native), native);
  }
  for (const changed of [
    { state: { state: { dashboardLanded: [{ id: 1, commit: 'a'.repeat(41) }] } } },
    { state: { state: { dashboardLanded: [{ id: 1, commit: 'a'.repeat(63) }] } } },
    { dashboardLanded: [{ id: 1, commit: 'a'.repeat(40) }] },
    { state: { state: { dashboardLanded: [{ id: 1, note: 'a'.repeat(40) }] } } },
  ]) assert.throws(() => publicSnapshot(changed), /secret-shaped string/u);
});

test('native fact and landing batch UUIDs remain metadata without exempting prose [N26]', () => {
  const id = '018fc314-57c9-7318-a11f-55a08a28a101';
  const fact = { type: 'fact', id, kind: 'measurement', text: 'Public observation', supersedes: null };
  const events = [
    { event_kind: 'fact', event_detail: JSON.stringify({ id, kind: 'measurement', text: 'Public observation' }) },
    { event_kind: 'landing_batch', event_detail: JSON.stringify({ batch: { id, state: 'gating' } }) },
    { event_kind: 'main-moved', event_detail: JSON.stringify({ batch: id }) },
  ];
  const native = { state: { state: { items: [{ thread: [fact] }], events } }, events: { events } };
  assert.deepEqual(publicSnapshot(native), native);
  for (const forged of [{ id }, { batch: { id } }, { type: 'fact', id },
    { state: { state: { items: [{ thread: [{ ...fact, text: id }] }] } } },
    { events: { events: [{ event_kind: 'fact', event_detail: JSON.stringify({ batch: id }) }] } },
    { events: { events: [{ event_kind: 'main-moved', event_detail: JSON.stringify({ batch: id + ' extra' }) }] } }]) {
    assert.throws(() => publicSnapshot(forged), /chat or agent session id/u);
  }
});

test('complete native batch hashes remain typed while private execution linkage is omitted [N26]', () => {
  const id = '018fc314-57c9-7318-a11f-55a08a28a101', commit = 'a'.repeat(40), tree = 'b'.repeat(64);
  // Schema contract only: this literal carries no recorded gate or landing assurance.
  const batch = { version: 1, id, state: 'gating', base: commit, tip: tree,
    root: '/Users/example/board', owner: id, logPath: '/Users/example/batch.log',
    candidates: [{ id: 1, commit }], items: [{ id: 1, commit, reviewedCommit: tree, merge: tree }],
    gateResults: [{ tree, affectedGate: 'c'.repeat(64), isGreen: false, logPath: '/Users/example/gate.log' }],
    proof: { tree, logPath: '/Users/example/proof.log' },
    invariantEvidence: { version: 1, gates: [{ commit, isGreen: false, submissions: [{ id: 1, commit }], failures: [], fileTimes: [] }],
      diagnostics: [{ commit, test: 'test/public.test.js', isGreen: false, wallMs: null }] } };
  const native = { events: { events: [{ event_kind: 'landing_batch', event_detail: JSON.stringify({ batch }) },
    { event_kind: 'main-moved', event_detail: JSON.stringify({ sha: tree, batch: id, items: [1] }) }] } };
  const projected = publicSnapshot(native);
  const actual = JSON.parse(projected.events.events[0].event_detail).batch;
  for (const key of ['root', 'owner', 'logPath']) assert.equal(Object.hasOwn(actual, key), false);
  assert.equal(Object.hasOwn(actual.gateResults[0], 'logPath'), false);
  assert.equal(Object.hasOwn(actual.proof, 'logPath'), false);
  assert.equal(actual.base, commit); assert.equal(actual.tip, tree);
  assert.equal(actual.items[0].reviewedCommit, tree); assert.equal(actual.gateResults[0].affectedGate, 'c'.repeat(64));
  assert.equal(actual.invariantEvidence.gates[0].submissions[0].commit, commit);
  assert.equal(JSON.parse(projected.events.events[1].event_detail).sha, tree);
  assert.equal(batch.root, '/Users/example/board', 'native source metadata is unchanged');
  for (const changed of [{ ...batch, tip: 'a'.repeat(41) }, { ...batch, note: commit },
    { ...batch, extra: { base: commit } }, { ...batch, note: '/Users/example/private-note' }]) {
    assert.throws(() => publicSnapshot({ events: { events: [{ event_kind: 'landing_batch', event_detail: JSON.stringify({ batch: changed }) }] } }),
      /PUBLIC_EXPORT_BLOCKED/u, 'unknown prose and malformed typed fields never gain a hash or private-field exemption');
  }
  assert.throws(() => publicSnapshot({ batch }), /PUBLIC_EXPORT_BLOCKED/u, 'an arbitrary batch object is not a native envelope');
});

test('retained object keys undergo the same public scan as their values [N26]', () => {
  for (const [kind, key] of [['pricing term', 'pricing.md'], ['email', 'fixture@example.invalid'],
    ['secret-shaped string', 'sk-fixtureonly12345678']]) {
    assert.throws(() => publicSnapshot({ state: { state: { rowAgesAt: { [key]: 'a'.repeat(40) } } } }), error =>
      error.code === 'PUBLIC_EXPORT_BLOCKED' && error.message.includes(kind)
      && !error.message.includes(key) && !error.next.includes(key));
  }
  const safe = { state: { state: { rowAgesAt: { 'SPEC.md': 'a'.repeat(40) } } } };
  assert.deepEqual(publicSnapshot(safe), safe);
});

test('home paths and chat session identifiers never survive public prose or keys [N26]', () => {
  const session = '018fc314-57c9-7318-a11f-55a08a28a101';
  for (const [kind, text] of [['home path', '/Users/example/Code/project'],
    ['home path', '/home/example/project'], ['chat or agent session id', session]]) {
    for (const input of [{ note: text }, { state: { state: { items: [{ thread: [{ kind: 'fact', detail: { note: text } }] }] } } },
      { state: { state: { rowAgesAt: { [text]: 'a'.repeat(40) } } } }]) {
      assert.throws(() => publicSnapshot(input), error => error.code === 'PUBLIC_EXPORT_BLOCKED'
        && error.message.includes(kind) && !error.message.includes(text) && !error.next.includes(text));
    }
  }
  for (const forged of [{ id: session }, { receipt: { id: session } },
    { events: { events: [{ event_kind: 'fact', event_detail: JSON.stringify({ receipt: { id: session } }) }] } },
    { state: { state: { items: [{ thread: [{ kind: 'proof-run', detail: { receipt: { id: session + ' extra' } } }] }] } } }]) {
    assert.throws(() => publicSnapshot(forged), /chat or agent session id/u, 'only a complete UUID at the exact native proof receipt id path qualifies');
  }
  assert.deepEqual(publicSnapshot({ note: 'Open docs/guide.md on the public site.' }), { note: 'Open docs/guide.md on the public site.' });
});

test('internal messages disappear from rows, historical JSON and derived decisions [N26]', () => {
  const internal = { shout_from: 'coordinator', shout_to: 'all', shout_text: 'Internal notice' };
  const external = { shout_from: 'web-1', shout_to: 'web', shout_text: 'Public progress' };
  const input = { state: { state: { shouts: [internal, external], needs: [{ kind: 'decision', text: 'Internal notice' }],
    events: [{ event_kind: 'shout', event_by: 'web-1', event_detail: JSON.stringify({ to: 'person', text: 'Internal notice' }) }],
    items: [{ thread: [{ kind: 'shout', by: 'sentinel', detail: { to: 'all', text: 'Internal notice' } }] }] } } };
  assert.deepEqual(publicSnapshot(input), { state: { state: { shouts: [external], needs: [], events: [], items: [{ thread: [] }] } } });
  assert.equal(input.state.state.shouts.length, 2, 'the pure filter does not mutate the source');
  const receipt = { commit: 'a'.repeat(40), parentSession: 'b'.repeat(64), runner: 'tester@host' };
  const proof = { kind: 'proof-run', detail: { receipt } };
  const proofEvent = { event_kind: 'proof-run', event_detail: JSON.stringify({ receipt }) };
  const projected = publicSnapshot({ state: { state: { items: [{ thread: [proof] }], events: [proofEvent] } }, events: { events: [proofEvent] } });
  assert.deepEqual(projected.state.state.items[0].thread[0].detail.receipt, { commit: receipt.commit });
  for (const event of [projected.state.state.events[0], projected.events.events[0]]) {
    assert.deepEqual(JSON.parse(event.event_detail).receipt, { commit: receipt.commit });
  }
  assert.equal(receipt.runner, 'tester@host', 'receipt projection leaves native source data intact');
  assert.throws(() => publicSnapshot({ events: { events: [{ event_kind: 'fact', event_detail: JSON.stringify({ receipt }) }] } }),
    /secret-shaped string/u, 'arbitrary receipt objects do not acquire omissions or identity exemptions');
  assert.throws(() => publicSnapshot({ events: [{ event_kind: 'fact', event_detail: '{"text":"\\u0070ricing"}' }] }), /pricing term/u,
    'encoded historical free text cannot bypass the scan');
  assert.deepEqual(publicSnapshot({ state: { state: { agents: [{ agent_id: 'web-1', agent_lane: 'web', agent_model: 'Fixture',
    agent_parent_session: 'a'.repeat(64), agent_path: '/work/test-host.local', host: 'a5x', executionRunner: 'user@host' }] } } }),
  { state: { state: { agents: [{ agent_id: 'web-1', agent_lane: 'web', model: 'Fixture' }] } } }, 'public agents have no internal session, worktree or machine linkage');
});

test('public CLI export refuses blocked prose without creating or changing output [N26]', () => {
  const box = machine();
  for (const [kind, text] of [BLOCKED[0], BLOCKED[6], BLOCKED[7], BLOCKED[11]]) {
    const alpha = project(box, `blocked-${kind.split(' ')[0]}`);
    box.run(alpha.repo, 'add', 'web', 'Public task', '--specs', 'G1', '--criterion', text);
    const output = join(alpha.repo, 'refused-export');
    const refused = command(box, alpha.repo, 'view', '--export', output, '--public');
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(JSON.parse(refused.stdout).error.message, new RegExp(kind));
    assert.equal(existsSync(output), false);
    mkdirSync(output);
    const again = command(box, alpha.repo, 'view', '--export', output, '--public');
    assert.equal(again.status, 1);
    assert.deepEqual(readdirSync(output), [], 'an existing empty destination remains empty');
    const normal = command(box, alpha.repo, 'view', '--export', join(alpha.repo, 'local-export'));
    assert.equal(normal.status, 0, normal.stderr);
  }
});

test('native private-board identity refuses a misplaced private snapshot [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'private-fixture');
  const previous = process.env.PULLBOARD_HOME;
  let privateFile;
  try {
    process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
    await withPrivateBoard('1'.repeat(32), (board, file) => {
      ensureCoordinator(board, alpha.repo);
      addItem(board, { by: 'coordinator', lane: 'web', title: 'Private fixture item' });
      privateFile = file;
    }, { create: true, store: { openBoard, atomic, closeBoard } });
  } finally {
    if (previous === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previous;
  }
  // Both files belong to this synthetic fixture: prove the native marker survives an accidental wrong location.
  copyFileSync(privateFile, join(alpha.repo, '.git/pullboard/board.sqlite'));
  const output = join(box.dir, 'private-refused');
  const refused = command(box, alpha.repo, 'view', '--export', output, '--public');
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(JSON.parse(refused.stdout).error.message, /private item/u);
  assert.equal(existsSync(output), false);
});

test('a clean public export renders offline with public work and no write path [N26]', { timeout: 120_000 }, async () => { // budget: one native fixture lifecycle and owned browser launch; a hang ceiling only.
  const executable = chromeExecutable();
  assert.ok(executable, 'the native public-export proof needs the configured browser');
  const box = machine();
  const alpha = project(box, 'clean-public');
  box.run(alpha.repo, 'add', 'web', 'Public task', '--specs', 'G1', '--criterion', 'The public page renders.');
  box.run(alpha.repo, 'add', 'web', 'Landed public task', '--specs', 'G1', '--criterion', 'The public work is landed.');
  build(box, alpha, 2, 'public.html');
  accept(box, alpha, 2);
  box.git(alpha.repo, 'merge', '-q', '--no-ff', alpha.branch, '-m', 'chore: land public fixture');
  const tip = box.git(alpha.repo, 'rev-parse', 'HEAD'), base = box.git(alpha.repo, 'rev-parse', 'HEAD^1');
  const batchId = randomUUID();
  // The helper's synthetic acceptance is lifecycle setup only, never gate or landing assurance.
  // @pullboard-board-file journey: genuine native batch operations project this private Git merge.
  const board = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const item = getItem(board, 2);
    recordLandingBatch(board, { agentId: 'coordinator', batch: { version: 1, id: batchId, state: 'trunk', base, tip,
      root: alpha.repo, branch: 'refs/heads/main', owner: randomUUID(),
      logPath: join(alpha.repo, '.git', 'pullboard', 'landings', batchId, 'batch.log'),
      items: [{ id: 2, commit: item.item_commit, merge: tip }], invariantEvidence: { version: 1, gates: [], diagnostics: [] } } });
    finishLandingBatch(board, { agentId: 'coordinator', id: batchId, tip });
    assert.equal(landingBatches(board).find(batch => batch.id === batchId).state, 'landed');
  } finally { closeBoard(board); }

  box.run(alpha.repo, 'milestone', 'add', 'Public milestone', '--items', '1,2', '--reason', 'Arrange fixture release');
  box.run(alpha.web, 'shout', 'web', 'Public progress');
  box.run(alpha.repo, 'shout', 'all', 'Internal notice');
  const fact = JSON.parse(box.run(alpha.repo, 'fact', '1', 'measurement', 'Public export fixture observation', '--json')).fact;
  const output = join(box.dir, 'clean-export');
  const result = command(box, alpha.repo, 'view', '--export', output, '--public');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const listing = JSON.parse(readFileSync(join(output, 'api/v1/boards.json'), 'utf8'));
  const state = JSON.parse(readFileSync(join(output, 'api/v1/boards', listing.boards[0].id, 'state.json'), 'utf8'));
  assert.equal(JSON.stringify(state).includes('Internal notice'), false);
  assert.ok(state.state.items.find(item => item.id === 2).merged);
  const exported = JSON.parse(readFileSync(join(output, 'api/v1/boards', listing.boards[0].id, 'events.json'), 'utf8'));
  const moved = exported.events.filter(event => event.event_kind === 'main-moved').map(event => JSON.parse(event.event_detail))
    .find(detail => detail.batch === batchId);
  const batches = exported.events.filter(event => event.event_kind === 'landing_batch').map(event => JSON.parse(event.event_detail).batch)
    .filter(batch => batch.id === batchId);
  assert.equal(moved.sha, tip, 'the real native main-moved hash remains public');
  assert.equal(batches.length, 2, 'initial and terminal native batch revisions survive');
  for (const batch of batches) {
    assert.equal(batch.base, base); assert.equal(batch.tip, tip);
    assert.equal(batch.items[0].merge, tip);
    for (const key of ['root', 'owner', 'logPath']) assert.equal(Object.hasOwn(batch, key), false, 'private batch execution linkage is omitted');
  }

  assert.equal(state.state.items.find(item => item.id === 1).thread.find(entry => entry.type === 'fact' && entry.id === fact.id)?.text,
    'Public export fixture observation', 'a real native fact keeps its public identity and prose');
  assert.ok(JSON.stringify(state.state.milestones).includes('Public milestone'));
  const staticView = await serveFolder(output, '/public/');
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, staticView.base + '/public/', join(box.dir, 'public-browser'));
    await chrome.waitFor("snapshot && data?.project?.items.some(item => item.title === 'Public task')");
    assert.equal(await chrome.stable('snapshot'), true);
    assert.equal(await chrome.stable("data.project.shouts.some(shout => shout.shout_text === 'Public progress')"), true);
    assert.equal(await chrome.stable("act('shout', {to:'web',text:'must not write'})"), false);
    const reads = staticView.requests.filter(request => request.path.includes('/api/'));
    assert.ok(reads.length > 0 && reads.every(request => request.status === 200), 'all board reads use static files');
  } finally {
    try { if (chrome) await closeSnapshotChrome(chrome); }
    finally { await staticView.close(); }
  }
});


test('private native submit admission links stay out of all public history projections [N26]', () => {
  const admission = { id: '018fc314-57c9-7318-a11f-55a08a28a101', commit: 'a'.repeat(40), tree: 'b'.repeat(64) };
  const receipt = { id: '018fc314-57c9-7318-a11f-55a08a28a102', commit: admission.commit, submitAdmission: admission.id };
  const thread = [{ kind: 'claim', detail: { digest: 'c'.repeat(64), submitAdmission: admission } },
    { kind: 'renew', detail: { submitAdmission: admission } }, { kind: 'proof-run', detail: { receipt } }];
  const events = thread.map(row => ({ event_kind: row.kind, event_detail: JSON.stringify(row.detail) }));
  const input = { state: { state: { items: [{ thread }], events } }, events: { events } };
  const before = JSON.stringify(input), output = publicSnapshot(input);
  assert.deepEqual(output.state.state.items[0].thread.map(row => row.detail),
    [{ digest: 'c'.repeat(64) }, {}, { receipt: { id: receipt.id, commit: receipt.commit } }]);
  for (const rows of [output.state.state.events, output.events.events]) {
    assert.deepEqual(rows.map(row => JSON.parse(row.event_detail)), output.state.state.items[0].thread.map(row => row.detail));
  }
  assert.equal(JSON.stringify(input), before, 'projection never mutates private native evidence');
  for (const forged of [{ submitAdmission: admission },
    { events: { events: [{ event_kind: 'fact', event_detail: JSON.stringify({ submitAdmission: admission }) }] } },
    { state: { state: { items: [{ thread: [{ kind: 'claim', detail: { submitAdmission: { ...admission, id: 'sk-fixtureonly12345678' } } }] }] } } },
    { state: { state: { events: [{ event_kind: 'renew', event_detail: JSON.stringify({ submitAdmission: { ...admission, commit: 'sk-fixtureonly12345678' } }) }] } } },
    { events: { events: [{ event_kind: 'renew', event_detail: JSON.stringify({ submitAdmission: { ...admission, note: 'sk-fixtureonly12345678' } }) }] } },
    { events: { events: [{ event_kind: 'claim', event_detail: JSON.stringify({ submitAdmission: 'sk-fixtureonly12345678' }) }] } },
    { events: { events: [{ event_kind: 'proof-run', event_detail: JSON.stringify({ receipt: { submitAdmission: 'sk-fixtureonly12345678' } }) }] } }]) {
    assert.throws(() => publicSnapshot(forged), error => error.code === 'PUBLIC_EXPORT_BLOCKED', 'arbitrary and malformed lookalikes keep the full privacy scan');
  }
});
