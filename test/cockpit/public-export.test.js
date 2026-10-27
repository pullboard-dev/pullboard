/** @pullboard-test-gui */
/** Public exports keep public prose and refuse private data before writing [N26]. */
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { withPrivateBoard } from '../../src/projects.js';
import { addItem } from '../../src/board.js';
import { ensureCoordinator } from '../../src/board.js';
import { PUBLIC_EXPORT_BLOCKS } from '../../src/view/public-export.js';
import { publicSnapshot } from '../../src/view/public-export.js';
import { runFixtureChild } from '../fixture-child.js';
import { BIN } from './fixture.js';
import { accept } from './fixture.js';
import { build } from './fixture.js';
import { chromeExecutable } from './fixture.js';
import { closeSnapshotChrome } from './fixture.js';
import { machine } from './fixture.js';
import { openSnapshotChrome } from './fixture.js';
import { project } from './fixture.js';
import { serveFolder } from './fixture.js';

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
  assert.deepEqual(PUBLIC_EXPORT_BLOCKS.text.map(([kind]) => kind), ['machine or host name', 'email', 'secret-shaped string', 'pricing term']);
  const labels = new Set(PUBLIC_EXPORT_BLOCKS.text.map(([kind]) => kind));
  for (const [kind, text] of BLOCKED) {
    assert.throws(() => publicSnapshot({ brief: text }), error => error.code === 'PUBLIC_EXPORT_BLOCKED'
      && error.message.includes(kind) && error.message.split(': ').at(-1).split(', ').every(label => labels.has(label)), kind);
  }
  assert.throws(() => publicSnapshot({ items: [{ title: 'Private fixture work' }] }, { privateBoard: true }), /private item/u);
  const native = { listing: { boards: [{ id: 'd'.repeat(32) }] }, state: { state: { board: 'd'.repeat(32), rowAgesAt: { 'SPEC.md': 'a'.repeat(40) },
    items: [{ id: 1, commit: 'a'.repeat(40), merged: 'b'.repeat(40) }] } },
    events: { events: [{ event_kind: 'submit', event_detail: JSON.stringify({ commit: 'a'.repeat(40), tree: 'b'.repeat(40), criterionDigest: 'c'.repeat(64) }) }] } };
  assert.deepEqual(publicSnapshot(native), native, 'only native paths with exact identifier widths are exempt');
  for (const forged of [{ customer_id: 'a'.repeat(64) }, { note_id: 'a'.repeat(64) }, { commit: 'a'.repeat(40) },
    { events: { events: [{ event_kind: 'fact', event_detail: JSON.stringify({ note_id: 'a'.repeat(64), commit: 'b'.repeat(40) }) }] } },
    { state: { state: { rowAgesAt: { 'SPEC.md': 'a'.repeat(64) } } } },
    { personRequests: [{ text: 'a'.repeat(64) }] }, { kind: 'decision', text: 'a'.repeat(64) }]) {
    assert.throws(() => publicSnapshot(forged), /secret-shaped string/u, 'arbitrary keys and wrong native shapes stay checked');
  }
  assert.throws(() => publicSnapshot({ commit: 'sk-fixtureonly12345678' }), /secret-shaped string/u, 'an identity key does not exempt an arbitrary credential');
  assert.deepEqual(publicSnapshot({ title: 'A private implementation detail', reviewPolicy: { sensitive: true }, brief: 'A sale client connects.' }),
    { title: 'A private implementation detail', reviewPolicy: { sensitive: true }, brief: 'A sale client connects.' }, 'review sensitivity and ordinary technical words are not privacy flags');
});

test('internal messages disappear from rows, historical JSON and derived decisions [N26]', () => {
  const internal = { shout_from: 'coordinator', shout_to: 'all', shout_text: 'Internal notice' };
  const external = { shout_from: 'web-1', shout_to: 'web', shout_text: 'Public progress' };
  const input = { state: { state: { shouts: [internal, external], needs: [{ kind: 'decision', text: 'Internal notice' }],
    events: [{ event_kind: 'shout', event_by: 'web-1', event_detail: JSON.stringify({ to: 'person', text: 'Internal notice' }) }],
    items: [{ thread: [{ kind: 'shout', by: 'sentinel', detail: { to: 'all', text: 'Internal notice' } }] }] } } };
  assert.deepEqual(publicSnapshot(input), { state: { state: { shouts: [external], needs: [], events: [], items: [{ thread: [] }] } } });
  assert.equal(input.state.state.shouts.length, 2, 'the pure filter does not mutate the source');
  assert.throws(() => publicSnapshot({ events: [{ event_kind: 'fact', event_detail: '{"text":"\\u0070ricing"}' }] }), /pricing term/u,
    'encoded historical free text cannot bypass the scan');
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
    }, { create: true });
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

test('a clean public export renders offline with public work and no write path [N26]', { timeout: 120_000 }, async t => { // budget: one native fixture lifecycle and owned browser launch; a hang ceiling only.
  const executable = chromeExecutable();
  assert.ok(executable, 'the native public-export proof needs the configured browser');
  const box = machine();
  const alpha = project(box, 'clean-public');
  box.run(alpha.repo, 'add', 'web', 'Public task', '--specs', 'G1', '--criterion', 'The public page renders.');
  box.run(alpha.repo, 'add', 'web', 'Landed public task', '--specs', 'G1', '--criterion', 'The public work is landed.');
  build(box, alpha, 2, 'public.html');
  accept(box, alpha, 2);
  box.git(alpha.repo, 'merge', '-q', '--no-ff', alpha.branch, '-m', 'chore: land public fixture');
  box.run(alpha.repo, 'merged', '2', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  box.run(alpha.repo, 'milestone', 'add', 'Public milestone', '--items', '1,2');
  box.run(alpha.web, 'shout', 'web', 'Public progress');
  box.run(alpha.repo, 'shout', 'all', 'Internal notice');
  const output = join(box.dir, 'clean-export');
  const result = command(box, alpha.repo, 'view', '--export', output, '--public');
  assert.equal(result.status, 0, result.stderr);
  const listing = JSON.parse(readFileSync(join(output, 'api/v1/boards.json'), 'utf8'));
  const state = JSON.parse(readFileSync(join(output, 'api/v1/boards', listing.boards[0].id, 'state.json'), 'utf8'));
  assert.equal(JSON.stringify(state).includes('Internal notice'), false);
  assert.ok(state.state.items.find(item => item.id === 2).merged);
  assert.ok(JSON.stringify(state.state.milestones).includes('Public milestone'));
  const staticView = await serveFolder(output, '/public/');
  t.after(() => staticView.close());
  const chrome = await openSnapshotChrome(executable, staticView.base + '/public/', join(box.dir, 'public-browser'));
  t.after(() => closeSnapshotChrome(chrome));
  await chrome.waitFor("snapshot && data?.project?.items.some(item => item.title === 'Public task')");
  assert.equal(await chrome.stable('snapshot'), true);
  assert.equal(await chrome.stable("data.project.shouts.some(shout => shout.shout_text === 'Public progress')"), true);
  assert.equal(await chrome.stable("act('shout', {to:'web',text:'must not write'})"), false);
  const reads = staticView.requests.filter(request => request.path.includes('/api/'));
  assert.ok(reads.length > 0 && reads.every(request => request.status === 200), 'all board reads use static files');
});
