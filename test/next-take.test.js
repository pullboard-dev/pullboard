/** Real Git, ordered board work and deterministic dispatch boundaries [N2,V1,B3,A6,V2]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as store from '../src/board.js';
import { main } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { applyRelayMove, appliedSequence, prepareEngineMove } from '../src/engine.js';
import { scanHealthSentinel } from '../src/health-sentinel.js';
import { addMilestone } from '../src/milestones.js';
import { heartbeatSeat } from '../src/seat-presence.js';
import { machineSettingsFile } from '../src/settings.js';
import { submitFixture } from './board-submit-fixture.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { AUTOMATIC_DISPATCH_ENGINE } from '../src/automatic-dispatch-engine.js';
import { Refused } from '../src/refused.js';
import { repoInfo } from '../src/git.js';
import { bindLocalSession } from '../src/agent-session.js';
import { recordItemSession } from '../src/item-sessions.js';
import { dispatchHealth } from '../src/dispatch-health.js';
import { deliverHealthNotices } from '../src/health-receipts.js';
import { runFixtureGit } from './fixture-child.js';

/** Run the actual command parser and operation pipeline against this fixture's clock. */
async function cli(box, cwd, args) {
  let out = '', err = '';
  const code = await main([...args, '--json'], { cwd, clock: box.clock,
    stdout: { isTTY: false, write: part => { out += part; } },
    stderr: { write: part => { err += part; } } });
  return { code, out, err, document: out.trim() ? JSON.parse(out) : null };
}

/** Isolate real worktrees and shared SQLite; only the explicitly injected clock advances time. */
async function fixture(t, { route = 'strong', family = 'off' } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-next-take-')));
  const root = join(directory, 'repo');
  mkdirSync(root);
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  /** Keep private Git hooks on this exact checkout's CLI, including paths containing quotes. */
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('../bin/pullboard.js', import.meta.url)))} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const overrides = { PULLBOARD_HOME: join(directory, 'home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const original = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  let at = Date.parse('2026-10-25T10:00:00.000Z');
  const clock = { now: () => new Date(at) };
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH,
    GIT_AUTHOR_NAME: 'Dispatch fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Dispatch fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  /** Run only real, isolated Git with the private hook executable. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', verify: { policy: 'any', family },
    lanes: { web: { owns: ['web/'] }, review: { owns: [] }, docs: { owns: ['docs/'] } } }));
  writeFileSync(join(root, 'SPEC.md'), '# Dispatch fixture\n## G\n- G1 [approved, must] Work keeps its evidence. | gate: true\n');
  writeFileSync(join(root, 'DOCTRINE.md'), '# Fixture rules\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'chore: initialize dispatch fixture [G1]');
  const settings = machineSettingsFile();
  mkdirSync(join(directory, 'machine'), { recursive: true });
  writeFileSync(settings, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false } }));
  const initialized = await cli({ clock }, root, ['init']);
  assert.equal(initialized.code, 0, initialized.out + initialized.err);
  const file = join(root, '.git/pullboard/board.sqlite');
  const board = store.openBoard(file, clock);
  const seats = {};
  for (const [name, lane, parent, vendor] of [
    ['actor', 'web', 'fixture-A', 'Family Alpha'], ['builder', 'web', 'fixture-P', 'Family Alpha'],
    ['sibling', 'review', 'fixture-P', 'Family Beta'], ['sameFamily', 'review', 'fixture-Q', 'Family Alpha'],
    ['outside', 'review', 'fixture-R', 'Family Beta'],
  ]) {
    const path = join(directory, name);
    git(root, 'worktree', 'add', '-q', '-b', `${lane}/${name}`, path);
    const id = store.register(board, { lane, path, parent, family: vendor, route: name === 'actor' ? route : 'strong' });
    seats[name] = { id, path, lane };
    heartbeatSeat(board, id);
  }
  const config = loadConfig(root);
  const box = { root, file, board, clock, seats, config, git, advance: ms => { at += ms; } };
  /** File an ordinary runnable item; tests never prefilter a candidate list for next. */
  box.add = (title, options = {}) => store.addItem(board, { by: 'coordinator', lane: 'web', title,
    criterion: 'The real fixture succeeds.', check: 'true', specIds: ['G1'],
    brief: `Files: ${options.lane === 'docs' ? 'docs' : 'web'}/dispatch.js\nTest: the real board selects the eligible item and retains its ownership.`, ...options });
  /** Set up authentic board ownership without claiming execution of a gate. */
  box.claim = (id, seat = seats.builder) => store.claim(board, id, { agentId: seat.id, lane: seat.lane,
    leaseMs: 3_600_000, freeze: item => {
      const text = JSON.stringify({ title: item.item_title, criterion: item.item_criterion, check: item.item_check, rows: [] });
      return { text, digest: createHash('sha256').update(text).digest('hex') };
    } });
  /** Publish synthetic board state at a real reachable commit, explicitly without a gate receipt. */
  box.submit = id => {
    box.claim(id);
    const head = git(seats.builder.path, 'rev-parse', 'HEAD');
    submitFixture(board, id, { agentId: seats.builder.id, commit: head, tree: git(root, 'rev-parse', `${head}^{tree}`) });
  };
  /** Apply the real health observation through authenticated ordered replay. */
  box.scan = () => {
    const observation = scanHealthSentinel(file, { root, config, now: clock.now(), cpu: () => [] });
    if (!observation) return null;
    const move = prepareEngineMove(board, 'recordHealthFindings', [{ agentId: 'coordinator', ...observation }], { actor: 'coordinator' });
    const result = applyRelayMove(board, move, { sequence: appliedSequence(board) + 1, at: clock.now().toISOString(),
      kind: 'move', sender: { kind: 'agent', agent: 'coordinator', userId: 'fixture-user' } });
    assert.equal(result.error, undefined, JSON.stringify(result));
    return result;
  };
  t.after(() => {
    store.closeBoard(board); rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return box;
}

test('a free seat is handed one eligible item without screening [N2,V1,B3]', async t => {
  const box = await fixture(t, { route: 'light' });
  const future = box.add('Older item in a future release', { route: 'light' });
  const wrongLane = box.add('Wrong lane', { lane: 'docs', route: 'light' });
  const strong = box.add('Wrong route', { route: 'strong' });
  const held = box.add('Held by the coordinator', { route: 'light' });
  store.holdItem(box.board, held, { agentId: 'coordinator', reason: 'A real fixture hold' });
  const ready = box.add('Current release item', { route: 'light' });
  addMilestone(box.board, { agentId: 'coordinator', name: 'Current', items: [wrongLane, strong, held, ready] });
  addMilestone(box.board, { agentId: 'coordinator', name: 'Future', items: [future] });
  const taken = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, ready);
  assert.equal(store.getItem(box.board, ready).item_owner, box.seats.actor.id);
  const claims = () => store.listItems(box.board).filter(item => item.item_status === 'claimed' && item.item_owner === box.seats.actor.id);
  await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(claims().length, 1, 'a holding seat never acquires another item');
  store.release(box.board, ready, box.seats.actor.id);
  const review = box.add('Review before another build', { route: 'light' });
  box.submit(review);
  const offered = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.item.item_id, review);
  assert.equal(store.getItem(box.board, review).item_review_by, box.seats.actor.id);
  assert.equal(claims().length, 0, 'review reservation and build claim are mutually exclusive');
});

test('a review goes only to an independent seat [V1,B3]', async t => {
  const box = await fixture(t, { family: 'require' });
  const id = box.add('Independent review');
  box.submit(id);
  for (const name of ['sibling', 'sameFamily']) {
    const refused = await cli(box, box.seats[name].path, ['next', '--take']);
    assert.equal(refused.code, 1, refused.out + refused.err);
    assert.equal(store.getItem(box.board, id).item_review_by, null, 'neither shared parent nor shared family is independent');
  }
  const taken = await cli(box, box.seats.outside.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(store.getItem(box.board, id).item_review_by, box.seats.outside.id);
  assert.deepEqual(store.verdictsFor(box.board, id), [], 'assignment never fabricates a review verdict');
});

test('ready work beside an idle seat for five minutes warns the coordinator [A6,N2]', async t => {
  const box = await fixture(t);
  const id = box.add('Unpaired ready work');
  box.scan(); // Start the prospective observation before advancing the private clock.
  const warnings = () => store.allShouts(box.board).filter(shout => shout.shout_to === 'coordinator'
    && shout.shout_text.startsWith('Stuck:') && shout.shout_text.includes(`#${id}`) && shout.shout_text.includes(box.seats.actor.id));
  box.advance(200000);
  store.appendFact(box.board, id, { agentId: 'coordinator', kind: 'note', text: 'A note does not change dispatch eligibility.' });
  box.advance(99999);
  box.scan();
  assert.equal(warnings().length, 0, 'the five-minute threshold is exact');
  box.advance(1);
  heartbeatSeat(box.board, box.seats.actor.id);
  box.scan();
  assert.equal(warnings().length, 1, 'the coordinator hears one concrete seat/item pairing');
  box.scan();
  assert.equal(warnings().length, 1, 'repeated observations of the same episode stay quiet');
  const result = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(result.code, 0, result.out + result.err);
  box.scan();
  assert.ok(store.getItem(box.board, id).item_owner);
  assert.equal(warnings().length, 1);
  assert.ok(store.allShouts(box.board).some(shout => shout.shout_text.startsWith('Resolved:') && shout.shout_text.includes('UNPAIRED_WORK')));
  store.release(box.board, id, box.seats.actor.id);
  box.scan();
  box.advance(299999);
  heartbeatSeat(box.board, box.seats.actor.id);
  box.scan();
  assert.equal(warnings().length, 1, 'a new episode must wait another whole five minutes');
  box.advance(1);
  box.scan();
  assert.equal(warnings().length, 2, 'clearing and reopening a pairing creates one new durable warning');
});

test('a coordinator edit never leaves an item unclaimable [V2,N2]', async t => {
  const box = await fixture(t);
  const id = box.add('An open corrected bar');
  const edited = await cli(box, box.root, ['edit', String(id), '--criterion', 'The corrected open criterion', '--reason', 'Correct the fixture bar']);
  assert.equal(edited.code, 0, edited.out + edited.err);
  const corrected = store.getItem(box.board, id);
  assert.ok(corrected.item_frozen_digest, 'an unclaimed correction freezes its bar in the same move');
  assert.equal(JSON.parse(corrected.item_frozen).criterion, 'The corrected open criterion');
  const taken = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  const held = store.getItem(box.board, id);
  const changed = await cli(box, box.root, ['edit', String(id), '--criterion', 'The corrected held criterion',
    '--check', 'true && true', '--reason', 'Correct the held fixture bar', '--wait']);
  assert.equal(changed.code, 0, changed.out + changed.err);
  const current = store.getItem(box.board, id);
  assert.equal(current.item_owner, held.item_owner);
  assert.equal(current.item_lease_until, held.item_lease_until);
  assert.equal(JSON.parse(current.item_frozen).criterion, 'The corrected held criterion');
  assert.equal(JSON.parse(current.item_frozen).check, 'true && true');
  assert.deepEqual(store.pendingRefreeze(box.board, id), []);
  const notices = store.inbox(box.board, held.item_owner).filter(shout => shout.shout_text.includes(`#${id}`));
  assert.ok(notices.some(shout => /correct/i.test(shout.shout_text) && !/pending|refreeze/i.test(shout.shout_text)));
  const renewed = await cli(box, box.seats.actor.path, ['claim', String(id)]);
  assert.equal(renewed.code, 0, renewed.out + renewed.err);
});


test('an explicit heartbeat and the installed native stop hook dispatch free seats [N2,I6]', async t => {
  const box = await fixture(t);
  const id = box.add('A heartbeat assigns work');
  const taken = await cli(box, box.seats.actor.path, ['heartbeat']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(store.getItem(box.board, id).item_owner, box.seats.actor.id);
  const another = box.add('A busy heartbeat cannot claim twice');
  await cli(box, box.seats.actor.path, ['heartbeat']);
  assert.equal(store.getItem(box.board, another).item_owner, null);
  store.release(box.board, id, box.seats.actor.id);
  const hook = await cli(box, box.seats.actor.path, ['hook', 'Stop']);
  assert.equal(hook.code, 0, hook.out + hook.err);
  assert.equal(store.getItem(box.board, id).item_owner, box.seats.actor.id, hook.out + hook.err);
  assert.equal(store.getItem(box.board, another).item_owner, null);
});

test('an atomic correction replays identically and a bad frozen payload changes no item [V2,H16]', async t => {
  const box = await fixture(t);
  const id = box.add('A deterministic corrected bar');
  box.claim(id, box.seats.actor);
  const replica = store.openBoard(join(box.root, '.git/pullboard/replica.sqlite'), box.clock);
  t.after(() => store.closeBoard(replica));
  importBoard(replica, exportBoard(box.board));
  const change = { agentId: 'coordinator', criterion: 'A sealed correction', reason: 'Correct the actual bar', correction: true,
    freeze: item => {
      const text = JSON.stringify({ title: item.item_title, criterion: item.item_criterion, check: item.item_check, rows: [] });
      return { text, digest: createHash('sha256').update(text).digest('hex') };
    } };
  const move = prepareEngineMove(box.board, 'editItem', [id, change], { actor: 'coordinator' });
  assert.equal(Object.hasOwn(move.args[1], 'freeze'), false, 'no callback travels to another replica');
  const options = { sequence: 1, at: box.clock.now().toISOString(), kind: 'move',
    sender: { kind: 'agent', agent: 'coordinator', userId: 'fixture-user' } };
  const result = applyRelayMove(box.board, move, options);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.deepEqual(applyRelayMove(replica, move, options), result);
  assert.deepEqual(exportBoard(replica), exportBoard(box.board), 'rows, notices, events and receipts match exactly');
  const beforeItem = store.getItem(box.board, id);
  const refusedFreeze = prepareEngineMove(replica, 'editItem', [id, { ...change,
    freeze: () => { throw new Refused('SPEC_DRAFT', 'the corrected row must be approved'); } }], { actor: 'coordinator' });
  const failedFreeze = applyRelayMove(replica, refusedFreeze, { ...options, sequence: 2 });
  assert.equal(failedFreeze.error?.code, 'SPEC_DRAFT');
  assert.deepEqual(store.getItem(replica, id), store.getItem(box.board, id));
  const invalid = structuredClone(move);
  invalid.id += '-invalid';
  invalid.args[1].frozen.digest = '0'.repeat(64);
  const refused = applyRelayMove(box.board, invalid, { ...options, sequence: 2 });
  assert.equal(refused.error?.code, 'RELAY_MOVE');
  assert.deepEqual(store.getItem(box.board, id), beforeItem);
  assert.deepEqual(store.events(box.board), store.events(replica), 'failed correction creates no edit or notice');
  const old = structuredClone(move);
  old.id += '-old'; old.engine = AUTOMATIC_DISPATCH_ENGINE - 1;
  const unchanged = exportBoard(replica);
  assert.throws(() => applyRelayMove(replica, old, { ...options, sequence: 3 }), error => error.code === 'RELAY_MOVE');
  assert.deepEqual(exportBoard(replica), unchanged, 'an old envelope cannot disguise the new semantics');
});


test('health reads each seat session instead of offering its own material for review [V1,B3,A6]', async t => {
  const box = await fixture(t);
  const id = box.add('Material from an earlier seat in the same session');
  box.submit(id);
  const info = repoInfo(box.seats.actor.path);
  const digest = 'a'.repeat(64);
  await bindLocalSession(info, { agent: box.seats.actor.id, digest });
  recordItemSession(info, id, 'submit', digest);
  const observed = dispatchHealth(box.board, box.config);
  assert.ok(observed.dispatch.some(pair => pair.item === id), 'an outside seat remains eligible');
  assert.ok(observed.dispatch.every(pair => pair.seat !== box.seats.actor.id), 'the old material ledger excludes the same session');
  box.scan();
  box.advance(300000);
  heartbeatSeat(box.board, box.seats.actor.id);
  const later = dispatchHealth(box.board, box.config);
  assert.ok(later.findings.every(finding => !finding.subject.includes(box.seats.actor.id)), 'no five-minute warning names an ineligible session');
});


test('health matches two free seats to distinct eligible work instead of hiding the second item [N2,A6]', async t => {
  const box = await fixture(t);
  const first = box.add('First ready item');
  const second = box.add('Second ready item');
  const observed = dispatchHealth(box.board, box.config);
  assert.deepEqual(new Set(observed.dispatch.map(pair => pair.item)), new Set([first, second]));
  assert.equal(new Set(observed.dispatch.map(pair => pair.seat)).size, 2);
  box.scan(); box.advance(300000); box.scan();
  const messages = store.allShouts(box.board).filter(shout => shout.shout_to === 'coordinator' && shout.shout_text.startsWith('Stuck:') && shout.shout_text.includes('UNPAIRED_WORK'));
  assert.equal(messages.length, 2, 'each distinct free pairing has one loud warning');
});

test('an expired claim is reclaimed through board eligibility on the next heartbeat [N2,B3]', async t => {
  const box = await fixture(t);
  const id = box.add('Expired work remains dispatchable');
  box.claim(id, box.seats.actor);
  box.advance(3600001);
  const taken = await cli(box, box.seats.actor.path, ['heartbeat']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  const current = store.getItem(box.board, id);
  assert.equal(current.item_owner, box.seats.actor.id);
  assert.ok(current.item_lease_until > box.clock.now().toISOString(), 'a raw stale claim cannot strand a free seat');
});


test('a capped dispatch warning is delivered once by the next ordinary sentinel pass [A6,N2]', () => {
  const warning = { key: 'UNPAIRED_WORK:web-1:1', cause: 'UNPAIRED_WORK', item: 1, subject: 'web-1 beside #1',
    title: 'unpaired work', since: '2026-10-25T10:00:00Z', why: 'the seat is free', next: 'run pullboard next --take', owner: 'coordinator' };
  const other = Array.from({ length: 10 }, (_, index) => ({ ...warning, key: `OTHER:${index}`, cause: 'OTHER' }));
  const sent = [];
  const delivery = { engine: AUTOMATIC_DISPATCH_ENGINE, coordinator: 'coordinator', targets: () => ['coordinator'],
    shout: (to, text) => sent.push({ to, text }), log: () => {} };
  const pending = deliverHealthNotices({ ...delivery, resolved: [], added: [...other, warning] });
  assert.deepEqual(pending, [warning], 'the cap cannot silently drop the five-minute warning');
  assert.equal(sent.filter(message => message.text.includes('[UNPAIRED_WORK]')).length, 0);
  assert.deepEqual(deliverHealthNotices({ ...delivery, resolved: [], added: [], pending }), []);
  assert.equal(sent.filter(message => message.text.includes('[UNPAIRED_WORK]')).length, 1);
});


test('a legacy pending correction is adopted atomically when its holder renews [V2,H16]', async t => {
  const box = await fixture(t);
  const id = box.add('A legacy correction must not strand current claims');
  box.claim(id, box.seats.actor);
  // This deliberately replays the older untyped edit protocol; new coordinator CLI edits carry their bar.
  const move = prepareEngineMove(box.board, 'editItem', [id, { agentId: 'coordinator',
    criterion: 'The already approved legacy correction', reason: 'Correct the legacy fixture' }], { actor: 'coordinator' });
  const result = applyRelayMove(box.board, move, { sequence: 1, at: box.clock.now().toISOString(), kind: 'move',
    sender: { kind: 'agent', agent: 'coordinator', userId: 'fixture-user' } });
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.deepEqual(store.pendingRefreeze(box.board, id), ['criterion'], 'the old receipt retains its historical meaning');
  const renewed = await cli(box, box.seats.actor.path, ['claim', String(id)]);
  assert.equal(renewed.code, 0, renewed.out + renewed.err);
  const current = store.getItem(box.board, id);
  assert.equal(current.item_owner, box.seats.actor.id);
  assert.equal(JSON.parse(current.item_frozen).criterion, 'The already approved legacy correction');
  assert.deepEqual(store.pendingRefreeze(box.board, id), []);
});
