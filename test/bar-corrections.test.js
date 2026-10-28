/** A corrected bar records why the old one was wrong, on the item and in stats [B10,B31,R1,H16]. */
import assert from 'node:assert/strict';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { applyEngineMove, applyRelayMove, prepareEngineMove } from '../src/engine.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const sandboxes = [];
const SPEC = '# Bar fixture\n\n## G · Goals\n- G1 [approved, must] The feature works. | gate: test\n';
const HOUR = 3_600_000;

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/** Make an isolated real-Git repo with a board, a coordinator, a web builder, a reviewer and three web items. */
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-bar-')));
  sandboxes.push(dir);
  const shims = join(dir, 'bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o755 });
  chmodSync(join(shims, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: `${shims}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_') && !name.startsWith('GIT_CONFIG') && !name.startsWith('GIT_AUTHOR') && !name.startsWith('GIT_COMMITTER')) delete env[name];
  delete env.PULLBOARD_RELAY_TOKEN;
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  /** Run Git in this private fixture with its isolated identity. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  /** Run the actual CLI in a fixture checkout and keep both output streams. */
  const run = (cwd, ...args) => {
    const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout ?? '', err: result.failure ?? result.stderr ?? '' };
  };
  /** Run a command that must succeed with --json and return its one document. */
  const json = (cwd, ...args) => {
    const result = run(cwd, ...args, '--json');
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
    return JSON.parse(result.out);
  };
  git(repo, 'init', '-q', '-b', 'main');
  assert.equal(run(repo, 'init').code, 0);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({
    gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h',
    lanes: { web: { owns: ['web/'], specs: ['G1'] } },
  }, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  mkdirSync(join(repo, 'web'));
  writeFileSync(join(repo, 'web', 'shared.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore: create bar fixture');
  const web = json(repo, 'worktree', 'web', '--route', 'strong').path;
  const review = json(repo, 'worktree', 'web', '--route', 'strong').path;
  for (const title of ['Corrected item', 'Unclaimed item', 'Build-failed item']) {
    json(repo, 'add', 'web', title, '--specs', 'G1', '--criterion', `${title} works`, '--check', 'true');
  }
  return { repo, web, review, run, json, git };
}

/** Submit and reject only this control item, leaving the other bar fixtures genuinely unclaimed. */
function rejectOnce(box, id, note) {
  writeFileSync(join(box.web, 'web', 'shared.txt'), `implemented item ${id}\n`);
  box.git(box.web, 'add', 'web/shared.txt');
  box.git(box.web, 'commit', '-q', '-m', 'fix: implement bar fixture [G1]');
  box.json(box.web, 'submit', String(id), '--no-next');
  box.git(box.review, 'switch', '--detach', box.json(box.repo, 'show', String(id)).item_commit);
  box.json(box.review, 'next', '--verify', String(id));
  box.json(box.review, 'verify', String(id), 'reject', '--reason', 'TEST_FAILURE', '--note', note, '--no-next');
}

test('[B10,B31] a corrected bar records why the old one was wrong', () => {
  const box = fixture();
  box.json(box.web, 'claim', '1');

  const refused = box.run(box.repo, 'edit', '1', '--criterion', 'Corrected item works under WAL', '--json');
  assert.notEqual(refused.code, 0, 'a criterion correction on a claimed item without a reason is refused');
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'BAR_REASON');
  assert.match(error.message, /--reason/, 'the refusal names the flag');
  assert.equal(box.json(box.repo, 'show', '1').item_criterion, 'Corrected item works', 'a refused correction changes nothing');

  box.json(box.repo, 'edit', '1', '--criterion', 'Corrected item works under WAL', '--reason', 'the old bar described a lock a WAL board never takes');
  const edit = box.json(box.repo, 'show', '1').thread.filter((entry) => entry.type === 'move' && entry.kind === 'edit').at(-1);
  assert.equal(edit.detail.reason, 'the old bar described a lock a WAL board never takes', 'the reason is stored with the edit');
  assert.deepEqual(edit.detail.barCorrection, { fields: ['criterion'], reject: null }, 'the edit is marked as a bar correction');

  const beforeRefreeze = box.json(box.repo, 'show', '1');
  const builderRefreeze = box.run(box.web, 'refreeze', '1', '--json');
  assert.notEqual(builderRefreeze.code, 0, 'only the coordinator refreezes a corrected bar');
  assert.equal(JSON.parse(builderRefreeze.out).error?.code, 'COORDINATOR_ONLY');
  const afterRefusal = box.json(box.repo, 'show', '1');
  assert.equal(afterRefusal.item_frozen_digest, beforeRefreeze.item_frozen_digest, 'the refused builder refreeze preserves the frozen bar');
  assert.equal(afterRefusal.item_owner, beforeRefreeze.item_owner, 'the refused builder refreeze preserves the owner');
  const refrozen = box.json(box.repo, 'refreeze', '1');
  assert.equal(refrozen.retainedClaim, true, 'coordinator refreeze keeps the active claim');
  assert.equal(refrozen.unchanged, true, 'the coordinator edit already made the corrected frozen bar effective');
  const afterRefreeze = box.json(box.repo, 'show', '1');
  assert.equal(afterRefreeze.item_status, 'claimed');
  assert.equal(afterRefreeze.item_owner, beforeRefreeze.item_owner);
  assert.equal(afterRefreeze.item_lease_until, beforeRefreeze.item_lease_until, 'refreeze keeps the existing lease');
  assert.equal(afterRefreeze.item_frozen_digest, beforeRefreeze.item_frozen_digest, 'an unchanged refreeze preserves the corrected bar digest');
  assert.equal(JSON.parse(afterRefreeze.item_frozen).criterion, 'Corrected item works under WAL');
  rejectOnce(box, 1, 'the WAL lock never appears');
  const unexplained = box.run(box.repo, 'edit', '1', '--check', 'true # wal', '--json');
  assert.equal(JSON.parse(unexplained.out).error?.code, 'BAR_REASON', 'a check correction on an item that was claimed needs a reason too');
  box.json(box.repo, 'edit', '1', '--check', 'true # wal', '--reason', 'the old check never opened a WAL board');
  const marked = box.json(box.repo, 'show', '1').thread.filter((entry) => entry.type === 'move' && entry.kind === 'edit').at(-1);
  assert.equal(marked.detail.barCorrection.reject?.by, 'web-2', 'a reject followed by a correction is marked as caused by the bar');
  assert.equal(marked.detail.barCorrection.reject?.reason, 'TEST_FAILURE');

  const shown = box.run(box.repo, 'show', '1');
  assert.equal(shown.code, 0, shown.err);
  assert.ok(shown.out.includes('bar corrected by coordinator (criterion): the old bar described a lock a WAL board never takes'), `show lists the first correction with its reason:\n${shown.out}`);
  assert.ok(shown.out.includes('bar corrected by coordinator (check): the old check never opened a WAL board; the reject by web-2 was caused by the bar'), 'show lists the second with its reason and the reject it explains');

  const plain = box.json(box.repo, 'edit', '2', '--criterion', 'Unclaimed item works better');
  assert.equal(plain.item.item_criterion, 'Unclaimed item works better', 'an edit before any claim needs no reason');
  const unclaimedEdit = box.json(box.repo, 'show', '2').thread.filter((entry) => entry.type === 'move' && entry.kind === 'edit').at(-1);
  assert.equal(unclaimedEdit.detail.barCorrection, undefined, 'an edit before any claim is not a bar correction');

  box.git(box.web, 'switch', '--detach', box.git(box.repo, 'rev-parse', 'HEAD'));
  box.json(box.web, 'claim', '3');
  rejectOnce(box, 3, 'the build is broken');
  const stats = box.json(box.repo, 'stats').stats.bars;
  assert.deepEqual(stats, { coordinator: { corrections: 2, barRejects: 1, buildRejects: 1 } },
    'stats reports, per coordinator, bar corrections and rejects caused by a bar, beside rejects caused by the build');
  const text = box.run(box.repo, 'stats');
  assert.match(text.out, /bars: coordinator: 2 corrections, 1 reject caused by a bar, 1 reject caused by the build/);
});

test('[B31,H16] the bar-correction rule replays by engine and takes nothing from the move but the reason', () => {
  let at = Date.parse('2026-10-17T00:00:00.000Z');
  const board = store.openBoard(':memory:', { now: () => new Date(at += 1000) });
  try {
    store.register(board, { lane: 'coordinator', path: '/repo' });
    store.register(board, { lane: 'web', path: '/repo-web-1' });
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Replayed', criterion: 'first' });
    store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR, freeze: (found) => ({ text: found.item_criterion, digest: 'd' }) });
    let sequence = 0;
    const receipt = () => ({ sequence: ++sequence, at: new Date(at).toISOString(), sender: { kind: 'agent', userId: 'user', agent: 'coordinator' }, kind: 'move' });

    const legacy = prepareEngineMove(board, 'editItem', [id, { agentId: 'coordinator', criterion: 'second' }]);
    legacy.engine = 12;
    assert.equal(applyRelayMove(board, legacy, receipt()).error, undefined, 'an engine-12 correction without a reason replays as it always did');
    assert.equal(store.getItem(board, id).item_criterion, 'second');

    const unexplained = prepareEngineMove(board, 'editItem', [id, { agentId: 'coordinator', criterion: 'third' }]);
    assert.equal(applyRelayMove(board, unexplained, receipt()).error?.code, 'BAR_REASON', 'a current correction without a reason is refused on every replica');

    const forged = prepareEngineMove(board, 'editItem', [id, { agentId: 'coordinator', criterion: 'third', reason: 'the second bar was wrong',
      barCorrection: { fields: [], reject: { by: 'web-9', reason: 'TEST_FAILURE' } } }]);
    assert.equal(applyRelayMove(board, forged, receipt()).error, undefined);
    const edit = store.events(board, { itemId: id }).filter((event) => event.event_kind === 'edit').map((event) => JSON.parse(event.event_detail)).at(-1);
    assert.deepEqual(edit.barCorrection, { fields: ['criterion'], reject: null }, 'the board derives the correction and its reject; a move cannot supply them');

    const old = prepareEngineMove(board, 'editItem', [id, { agentId: 'coordinator', criterion: 'fourth', reason: 'older engine' }]);
    old.engine = 12;
    const before = store.events(board).length;
    assert.throws(() => applyEngineMove(board, old, { sequence: sequence + 1, at: new Date(at).toISOString() }), { code: 'RELAY_MOVE' },
      'a reason-bearing edit sealed below the bar engine is refused before it is interpreted');
    assert.equal(store.events(board).length, before);

    const agent = applyRelayMove(board, prepareEngineMove(board, 'editItem', [id, { agentId: 'coordinator', criterion: 'fifth', reason: 'forged' }]),
      { ...receipt(), sender: { kind: 'agent', userId: 'user', agent: 'web-1' } });
    assert.equal(agent.error?.code, 'RELAY_SENDER_MISMATCH', 'an agent cannot correct a bar as the coordinator through the relay');
  } finally { store.closeBoard(board); }
});
