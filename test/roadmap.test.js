/** Roadmap progress and withdrawn work preserve their recorded meaning [N26]. */
import { addMilestone as addMilestoneWithPorts } from '../src/milestones.js';
import { milestoneFocus } from '../src/focus-milestone.js';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { main } from '../src/cli.js';
import { milestoneRoadmap } from '../src/roadmap.js';
import { submitFixture } from './board-submit-fixture.js';
import {
  MILESTONE_SHIP_ENGINE,
  WITHDRAW_MILESTONE_ENGINE,
} from '../src/milestones.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { prepareEngineMove } from '../src/engine.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const HOUR = 3_600_000;
const TEMP_DIRS = [];

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/**
 * A real repo on main with an initialized board, a builder agent, and a helper that files an item
 * in the state the roadmap tells apart: open, accepted (verified only) or landed (verified with a
 * merge commit). Git runs with every GIT_* variable stripped, so a hook's repository never leaks in.
 */
function withdrawFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-'));
  TEMP_DIRS.push(dir);
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // The repo's hooks call pullboard by name, so the fixture puts this checkout's CLI on PATH.
  /** Quote a value for the fixture's private shell launcher. */
  const word = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${word(process.execPath)} ${word(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { HOME: join(dir, 'home'), PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Roadmap fixture', GIT_AUTHOR_EMAIL: 'roadmap@example.invalid',
    GIT_COMMITTER_NAME: 'Roadmap fixture', GIT_COMMITTER_EMAIL: 'roadmap@example.invalid', PATH: `${bin}:${process.env.PATH}` });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  /** Run Git inside a fixture repo with its private identity. */
  const gitAt = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  const git = (...args) => gitAt(repo, ...args);
  /** Run pullboard from the main checkout, where it acts as the coordinator, and require success. */
  const runAt = (cwd, ...args) => {
    const result = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    return result.stdout;
  };
  const run = (...args) => runAt(repo, ...args);
  /** Run a command that must succeed and return its JSON document. */
  const json = (...args) => JSON.parse(run(...args, '--json'));
  run('init');
  writeFileSync(join(repo, 'SPEC.md'), '# Fixture\n\n## G · Goals\n- G1 [approved, must] Work is tracked. | gate: true\n');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ name: 'Local Alias', gate: 'true', verify: 'any', lanes: { web: { owns: ['web/'], specs: ['G1'] } }, shared: [] }));
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: initialize fixture');
  const board = store.openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  store.ensureCoordinator(board, repo);
  const builder = store.register(board, { lane: 'web', path: join(dir, 'builder'), model: 'Fixture Model' });
  /** Supply the stable criterion snapshot used by these synthetic board transitions. */
  const freeze = () => ({ text: 'Tracked work', digest: 'digest:tracked' });
  /** File an item and take it to the named state: open, accepted or landed. */
  const item = (title, state) => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title, criterion: 'Tracked work', specIds: ['G1'] });
    if (state === 'open') return id;
    const commit = String(id).repeat(40).slice(0, 40);
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: HOUR, freeze });
    submitFixture(board, id, { agentId: builder, commit, tree: 'tree' });
    store.verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'checked it', head: commit, digest: 'digest:tracked', policy: 'any' });
    if (state === 'landed') store.merged(board, id, { agentId: 'coordinator', commit: git('rev-parse', 'HEAD') });
    return id;
  };
  return { run, runAt, gitAt, dir, json, board, item };
}

/** A real Git repository and SQLite board with a shared, controlled command clock. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
  Object.assign(process.env, { HOME: join(dir, 'home'), PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Roadmap fixture', GIT_AUTHOR_EMAIL: 'roadmap@example.invalid',
    GIT_COMMITTER_NAME: 'Roadmap fixture', GIT_COMMITTER_EMAIL: 'roadmap@example.invalid' });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'SPEC.md'), '# Fixture\n\n## G · Goals\n- G1 [approved, must] Work is tracked. | gate: true\n');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true', verify: 'any',
    lanes: { web: { owns: ['web/'], specs: ['G1'] }, paused: { owns: ['paused/'], specs: ['G1'] } }, shared: [] }));
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'chore: initialize fixture']);
  const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  let instant = Date.parse('2026-10-17T12:00:00Z');
  const clock = { now: () => new Date(instant) };
  const board = store.openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'), clock);
  t.after(() => store.closeBoard(board));
  store.ensureCoordinator(board, repo);
  const builder = store.register(board, { lane: 'web', path: join(dir, 'builder'), model: 'Fixture Model' });
  /** Advance the board clock without editing its stored records. */
  const at = value => { instant = value; };
  /** File work and advance it through ordinary board operations to the requested state. */
  const item = (state, lane = 'web') => {
    const id = store.addItem(board, { by: 'coordinator', lane, title: state + ' work', criterion: 'Tracked work', specIds: ['G1'] });
    if (['waiting', 'held'].includes(state)) {
      if (state === 'held') store.holdItem(board, id, { agentId: 'coordinator', reason: 'Waiting for a judgment' });
      return id;
    }
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: HOUR,
      freeze: () => ({ text: 'Tracked work', digest: 'digest:tracked' }) });
    if (state === 'building') return id;
    submitFixture(board, id, { agentId: builder, commit, tree: 'tree' });
    if (state === 'review') return id;
    store.verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'checked it',
      head: commit, digest: 'digest:tracked', policy: 'any' });
    if (state === 'landed') store.merged(board, id, { agentId: 'coordinator', commit });
    return id;
  };
  /** Read the public command with the same clock as the board's projections. */
  const run = async (json = true) => {
    let stdout = ''; let stderr = '';
    const code = await main(['roadmap', ...(json ? ['--json'] : [])], { cwd: repo, clock,
      stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
    assert.equal(code, 0, stdout + stderr);
    return json ? JSON.parse(stdout) : stdout;
  };
  return { repo, board, clock, commit, at, item, run };
}

test('withdraw leaves every milestone and the roadmap lists work to ship first [N26]', (t) => {
  const { run, runAt, gitAt, dir, json, board, item } = withdrawFixture(t);
  const landed = item('Landed page', 'landed');
  const dropped = item('Dropped idea', 'open');
  const first = item('First open page', 'open');
  const accepted = item('Accepted page', 'accepted');
  const second = item('Second open page', 'open');
  const unrelated = item('Unrelated page', 'open');
  const foreignRepo = join(dir, 'foreign');
  mkdirSync(foreignRepo);
  gitAt(dir, 'init', '-q', '-b', 'main', foreignRepo);
  runAt(foreignRepo, 'init');
  const foreignBoard = store.openBoard(join(foreignRepo, '.git', 'pullboard', 'board.sqlite'));
  let foreignItem;
  try {
    store.ensureCoordinator(foreignBoard, foreignRepo);
    for (let index = 1; index < dropped; index++) {
      store.addItem(foreignBoard, { by: 'coordinator', lane: 'web', title: `Foreign filler ${index}` });
    }
    foreignItem = store.addItem(foreignBoard, { by: 'coordinator', lane: 'web', title: 'Foreign same-id item' });
  } finally {
    store.closeBoard(foreignBoard);
  }
  assert.equal(foreignItem, dropped, 'the registered foreign board has a real item with the same numeric ID');
  for (const name of ['ambiguous-one', 'ambiguous-two']) {
    const root = join(dir, name);
    mkdirSync(root);
    gitAt(dir, 'init', '-q', '-b', 'main', root);
    runAt(root, 'init');
    const configPath = join(root, 'pullboard.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    writeFileSync(configPath, JSON.stringify({ ...config, name: 'Shared Alias' }));
  }
  const namedAlias = `Local Alias#${dropped}`;
  const basenameAlias = `repo#${dropped}`;
  const foreignAlias = `foreign#${dropped}`;
  const ambiguousAlias = `Shared Alias#${dropped}`;
  run('milestone', 'add', 'Now', '--items', [landed, dropped, first, accepted, second].join(','));
  run('milestone', 'add', 'Later', '--items', [second, dropped].join(','));
  run('milestone', 'add', 'Aliases', '--items', [namedAlias, basenameAlias, foreignAlias, ambiguousAlias].join(','));
  run('milestone', 'add', 'Elsewhere', '--items', String(unrelated));

  // Probe both sealed writers without consuming fixture IDs or changing board state.
  const withdrawMove = prepareEngineMove(board, 'withdraw', [dropped, { agentId: 'coordinator', reason: 'writer version' }], { id: 'withdraw-writer', actor: 'coordinator' });
  const cleanupMove = prepareEngineMove(board, 'editMilestoneItems', ['Now', { agentId: 'coordinator', remove: [dropped] }], { id: 'milestone-writer', actor: 'coordinator' });
  assert.equal(WITHDRAW_MILESTONE_ENGINE, 51, 'withdraw retains its allocated feature engine');
  assert.ok(ENGINE_VERSION >= WITHDRAW_MILESTONE_ENGINE, 'the current writer retains withdraw semantics');
  assert.equal(withdrawMove.engine, ENGINE_VERSION, 'withdraw writes use the current engine');
  assert.equal(cleanupMove.engine, ENGINE_VERSION, 'milestone cleanup writes use the current engine');

  // Withdraw removes the item from every milestone that lists it and says which, in roadmap order.
  const said = run('withdraw', String(dropped), 'not recurring');
  assert.match(said, new RegExp(`withdrew #${dropped}; removed it from milestone Now, Later, Aliases`), 'withdraw names each milestone it left');
  const lists = Object.fromEntries(store.milestones(board).map((entry) => [entry.name, entry.items]));
  assert.deepEqual(lists, { Now: [landed, first, accepted, second], Later: [second], Aliases: [foreignAlias, ambiguousAlias], Elsewhere: [unrelated] }, 'numeric membership and both local aliases leave their milestones, while foreign and ambiguous aliases remain');
  const removals = store.events(board).filter((event) => event.event_kind === 'milestone_items').map((event) => JSON.parse(event.event_detail));
  assert.deepEqual(removals.map(({ name, remove }) => [name, remove]), [['Now', [dropped]], ['Later', [dropped]], ['Aliases', [namedAlias, basenameAlias]]], 'each milestone records exactly its local references in stored order');
  const quiet = json('withdraw', String(unrelated), 'folded into another item');
  assert.deepEqual(quiet.milestones, ['Elsewhere'], 'the JSON result names the milestones too');
  assert.equal(json('withdraw', String(item('Never planned', 'open')), 'not needed').milestones.length, 0, 'an item no milestone lists leaves none');

  // A board from before this change still names a withdrawn item: the roadmap neither shows nor counts it.
  const stale = item('Stale withdrawn page', 'open');
  run('milestone', 'add', 'Old', '--items', [stale, landed].join(','));
  store.withdraw(board, stale, { agentId: 'coordinator', reason: 'withdrawn before withdraw left milestones' });
  assert.deepEqual(store.milestones(board).find((entry) => entry.name === 'Old').items, [stale, landed], 'the old board still names it');

  const roadmap = Object.fromEntries(json('roadmap').milestones.map((entry) => [entry.name, entry]));
  assert.deepEqual(roadmap.Now.items.map((entry) => [entry.id, entry.state]),
    [[first, 'open'], [second, 'open'], [landed, 'landed'], [accepted, 'accepted']], 'work to ship first, verified after, each in milestone order');
  assert.deepEqual([roadmap.Now.landed, roadmap.Now.done, roadmap.Now.total], [1, 1, 4], 'Now counts 1/4 landed');
  assert.deepEqual(roadmap.Aliases.items.map(({ id, status }) => [id, status]),
    [[foreignAlias, 'open'], [ambiguousAlias, 'unavailable']], 'the foreign same-ID board resolves independently and duplicate project names remain ambiguous');
  assert.deepEqual(roadmap.Old.items.map((entry) => entry.id), [landed], 'a withdrawn item is never shown');
  assert.deepEqual([roadmap.Old.done, roadmap.Old.total, roadmap.Old.withdrawn], [1, 1, 1], 'nor counted: Old is finished, 1/1, with one withdrawn item set aside');
  assert.deepEqual([roadmap.Elsewhere.total, roadmap.Elsewhere.items], [0, []], 'a milestone whose only item was withdrawn is empty');

  const text = run('roadmap');
  const itemText = text.replace(/^ {2}\d+ left of \d+: [^\n]*\n/gm, '');
  assert.match(itemText, /^Now: 1\/4 landed\n {2}#3 First open page — open\n {2}#5 Second open page — open\n {2}#1 Landed page — landed\n {2}#4 Accepted page — accepted$/m, 'the text roadmap lists the same order and count');
  assert.match(itemText, /^Old: 1\/1 landed\n {2}#1 Landed page — landed$/m, 'and leaves the withdrawn item out of the text');
  assert.doesNotMatch(text, /Stale withdrawn page|Dropped idea/, 'no withdrawn item appears anywhere in the text roadmap');
});

test('[N26] each milestone sums its items by state with an estimate', async t => {
  const box = fixture(t);
  const now = box.clock.now().getTime();
  const landings = [];
  for (const hours of [7, 6, 4, 3, 1.5, 1, 0.5]) {
    box.at(now - hours * HOUR);
    landings.push(box.item('landed'));
  }
  box.at(now);
  // Recording an old landing again must not turn it into new progress.
  store.merged(box.board, landings[0], { agentId: 'coordinator', commit: box.commit });
  const landing = box.item('landing');
  const review = box.item('review');
  const building = box.item('building');
  const held = box.item('held');
  const waiting = box.item('waiting');
  const withdrawn = box.item('waiting');
  store.withdraw(box.board, withdrawn, { agentId: 'coordinator', reason: 'No longer planned' });
  const ids = [landings.at(-1), landing, review, building, held, waiting, withdrawn];
  store.addMilestone(box.board, { agentId: 'coordinator', name: 'A', items: ids });
  const ask = store.shout(box.board, { from: 'coordinator', to: store.PERSON, lanes: ['web'], decision: true,
    text: `Choose for #${waiting}, #${waiting}, #${withdrawn}; foreign#${review} and https://example.invalid/#${landing} are outside`,
    evidence: { kind: 'attempt', outcome: 'Needs judgment', item: held, commit: box.commit } });
  const expected = { total: 6, left: 5, landed: 1, landing: 1, review: 1, building: 1, held: 1, waiting: 1,
    needsYou: [held, waiting], pace: { last6h: 5, last2h: 3, last24h: 7 }, estimate: { low: 3.5, high: 6 }, window: '6h', reason: null };
  assert.deepEqual((await box.run()).milestones[0].summary, expected);
  assert.match(await box.run(false), /^  5 left of 6: 1 landed, 1 landing, 1 in review, 1 building, 1 waiting, 1 held; about 3.5 to 6 h at today's pace\.$/m);
  const direct = milestoneRoadmap(box.repo, box.board, { projects: () => [], ports: store })[0];
  assert.equal(direct.total, 6, 'withdrawn work is excluded from milestone membership');
  assert.equal(direct.withdrawn, 1, 'the omitted withdrawn member remains reported separately');
  assert.ok(direct.items.every(entry => entry.status !== 'withdrawn'));
  assert.equal(direct.done, 1);
  assert.deepEqual(direct.items.map(entry => entry.id),
    [review, building, held, waiting, landings.at(-1), landing], 'the roadmap keeps work to ship first and omits withdrawn work');
  assert.equal(['landed', 'landing', 'review', 'building', 'held', 'waiting'].reduce((sum, key) => sum + direct.summary[key], 0), direct.summary.total);
  store.shout(box.board, { from: store.PERSON, to: 'coordinator', lanes: ['web'], answers: ask, text: 'Choose it' });
  assert.deepEqual((await box.run()).milestones[0].summary.needsYou, [], 'answered questions no longer need the person');
  box.at(now + 2 * HOUR);
  const later = (await box.run()).milestones[0].summary;
  assert.equal(later.building, 0, 'an expired claim becomes waiting');
  assert.equal(later.waiting, 2);
  assert.deepEqual(later.pace, { last6h: 4, last2h: 0, last24h: 7 });
  assert.deepEqual(later.estimate, { low: 7.5, high: 7.5 }, 'a zero short window uses the positive six-hour rate');
  box.at(now + 6 * HOUR);
  assert.deepEqual((await box.run()).milestones[0].summary.estimate, { low: 17, high: 17 }, 'sparse recent progress falls back to the full day');
  box.at(now);
  store.addMilestone(box.board, { agentId: 'coordinator', name: 'B', items: [] });
  store.shipMilestone(box.board, 'A', { agentId: 'coordinator', commit: box.commit });
  const shipped = (await box.run()).milestones[0];
  assert.equal(shipped.summary.estimate, null, 'a shipped milestone has no estimate even at a known pace');
  assert.doesNotMatch((await box.run(false)).split('B:')[0], /left of/, 'the shipped milestone has no summary line');
});


test('[N26] roadmap holds and unavailable scoped references partition without leaking names', async t => {
  const box = fixture(t);
  const now = box.clock.now().getTime();
  const building = box.item('building');
  store.holdItem(box.board, building, { agentId: 'coordinator', reason: 'Next stage waits' });
  const paused = box.item('waiting', 'paused');
  store.holdLane(box.board, 'paused', { agentId: 'coordinator', reason: 'Paused lane' });
  store.addMilestone(box.board, { agentId: 'coordinator', name: 'Scoped', items: [building, paused, 'unregistered-private#7'] });
  const scoped = milestoneRoadmap(box.repo, box.board, { projects: () => [], hideOutOfScope: true, ports: store })[0];
  assert.equal(scoped.summary.building, 1, 'a live builder takes precedence over a hold');
  assert.equal(scoped.summary.held, 1, 'a held lane counts its open work');
  assert.equal(scoped.summary.waiting, 1, 'an unresolved foreign item remains in the total');
  assert.equal(scoped.summary.total, 3);
  assert.equal(scoped.summary.estimate, null);
  assert.doesNotMatch(JSON.stringify(scoped), /unregistered-private/, 'the summary preserves scoped reference redaction');
  box.at(now + 2 * HOUR);
  const expired = milestoneRoadmap(box.repo, box.board, { projects: () => [], hideOutOfScope: true, ports: store })[0].summary;
  assert.equal(expired.building, 0);
  assert.equal(expired.held, 2, 'the expired builder is held instead of waiting');
  assert.equal(expired.waiting, 1);
});


test('[N26] an estimate with equal bounds prints one number', async t => {
  const box = fixture(t);
  const now = box.clock.now().getTime();
  // Equal six-hour and two-hour rates make the rounded decimal bounds equal.
  for (const hours of [...Array(8).fill(5.75), ...Array(4).fill(1)]) {
    box.at(now - hours * HOUR);
    box.item('landed');
  }
  box.at(now);
  const items = Array.from({ length: 5 }, () => box.item('waiting'));
  store.addMilestone(box.board, { agentId: 'coordinator', name: 'Estimate', items });
  assert.deepEqual((await box.run()).milestones[0].summary.estimate, { low: 2.5, high: 2.5 },
    'JSON retains both equal bounds');
  const equal = await box.run(false);
  assert.match(equal, /; about 2\.5 h at today's pace\./u);
  assert.doesNotMatch(equal, /2\.5 to 2\.5/u);

  // Aging the older landings out of the long window separates the two rates.
  box.at(now + 0.5 * HOUR);
  assert.deepEqual((await box.run()).milestones[0].summary.estimate, { low: 2.5, high: 7.5 },
    'JSON retains both different bounds');
  assert.match(await box.run(false), /; about 2\.5 to 7\.5 h at today's pace\./u);
});


test('[N26] a slow day estimates from the last 24 hours', async t => {
  const box = fixture(t);
  const now = box.clock.now().getTime();
  for (const hours of [2.1, 2.5, 3, 3.5, 4, 4.5, 5, 7, 8, 9, 10, 11]) {
    box.at(now - hours * HOUR);
    box.item('landed');
  }
  box.at(now);
  const items = Array.from({ length: 3 }, () => box.item('waiting'));
  store.addMilestone(box.board, { agentId: 'coordinator', name: 'Slow', items });
  // These are observations of the same real history; no moves are written while changing its query clock.
  box.at(now + 7 * HOUR);
  const slow = (await box.run()).milestones[0].summary;
  assert.deepEqual(slow.estimate, { low: 6, high: 6 }, 'a slow day uses the positive full-day rate');
  assert.equal(slow.window, '24h');
  assert.equal(slow.reason, null);
  assert.deepEqual(slow.pace, { last6h: 0, last2h: 0, last24h: 12 });
  assert.match(await box.run(false), /; about 6 h at the last day's pace\./u);

  box.at(now);
  const recent = (await box.run()).milestones[0].summary;
  assert.deepEqual(recent.estimate, { low: 2.5, high: 2.5 });
  assert.equal(recent.window, '6h');
  assert.deepEqual(recent.pace, { last6h: 7, last2h: 0, last24h: 12 });
  assert.match(await box.run(false), /; about 2\.5 h at today's pace\./u);
  box.at(now + 2.5 * HOUR);
  assert.equal((await box.run()).milestones[0].summary.window, '6h', 'three recent landings still prefer the six-hour rate');
  box.at(now + 3 * HOUR);
  const justSlow = (await box.run()).milestones[0].summary;
  assert.equal(justSlow.pace.last6h, 2);
  assert.equal(justSlow.window, '24h', 'two recent landings use the full-day fallback');

  box.at(now + 20.5 * HOUR);
  const threshold = (await box.run()).milestones[0].summary;
  assert.equal(threshold.pace.last24h, 3, 'the exact24h boundary is outside the window');
  assert.deepEqual(threshold.estimate, { low: 24, high: 24 }, 'three full-day landings are enough');
  assert.equal(threshold.window, '24h');
  box.at(now + 21 * HOUR);
  const sparse = (await box.run()).milestones[0].summary;
  assert.equal(sparse.pace.last24h, 2);
  assert.equal(sparse.estimate, null);
  assert.equal(sparse.window, null);
  assert.equal(sparse.reason, 'few-landings');
  assert.match(await box.run(false), /; too few landings yet to estimate\./u);

  store.addMilestone(box.board, { agentId: 'coordinator', name: 'Next', items: [] });
  store.shipMilestone(box.board, 'Slow', { agentId: 'coordinator', commit: box.commit });
  const shipped = (await box.run()).milestones[0].summary;
  assert.deepEqual({ estimate: shipped.estimate, window: shipped.window, reason: shipped.reason },
    { estimate: null, window: null, reason: null }, 'shipping is not mislabeled as sparse history');
  assert.doesNotMatch((await box.run(false)).split('Next:')[0], /left of|too few landings|about .* h/u);
});

/** Missing store providers must refuse before a roadmap operation reads or mutates a real board. */
test('roadmap ports refuse before board access while canonical composition retains native events [N26,H16,C7]', () => {
  const board = store.openBoard(':memory:');
  try {
    const before = store.events(board);
    assert.throws(() => addMilestoneWithPorts(board, { agentId: 'coordinator', name: 'Missing' }), TypeError);
    assert.throws(() => milestoneRoadmap('.', board), TypeError);
    assert.throws(() => milestoneFocus(board), TypeError);
    assert.deepEqual(store.events(board), before, 'missing ports add no native events');
    assert.deepEqual(store.milestones(board), [], 'missing ports never write roadmap metadata');
    store.addMilestone(board, { agentId: 'coordinator', name: 'Bound' });
    assert.equal(store.milestones(board)[0].name, 'Bound');
    assert.equal(store.events(board).at(-1).event_kind, 'milestone_add', 'the public adapter still records the real native event');
  } finally { store.closeBoard(board); }
});
