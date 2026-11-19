/** With relay.queueOnFailure on, a linked device whose board key is unreadable applies claim, shout and answer locally and keeps them key-free in the unsealed outbox [C7,#9411]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import test from 'node:test';
import { runFixtureChild as spawnSync } from '../../tests/fixtures/child.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import { fixtureMachineSettings } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';

/** Run the production CLI in this process with the fixture's isolated environment [C7]. */
function inProcessCli(box) {
  return (cwd, ...args) => runCliInProcess(args, { cwd, env: box.env });
}

/** Commit every fixture file with Git plumbing, which runs no hook: the seed is setup [C7]. */
function seedCommit(box) {
  const git = (...args) => {
    const step = spawnSync('git', args, { cwd: box.root, env: box.env, encoding: 'utf8' });
    assert.equal(step.status, 0, step.stderr);
    return step.stdout.trim();
  };
  git('add', '-A');
  const commit = git('commit-tree', git('write-tree'), '-p', 'HEAD', '-m', 'chore(test): seed fixture');
  git('update-ref', 'HEAD', commit);
}

/** The one run both clauses read: the three moves cost a relay fixture, two worktrees and a link, so the second clause reuses the first clause's observations [C7]. */
let observed;

/** A linked board with relay.queueOnFailure on, an open decision, and a board key this shell cannot read; then claim 1, shout all and answer yes run from the real worktrees. */
async function unreadableKeyMoves(t) {
  observed ??= await runUnreadableKeyMoves(t);
  return observed;
}

/** Make the board, remove read access to its key, run the three moves and take every observation the clauses need. */
async function runUnreadableKeyMoves(t) {
  const box = await relayClientFixture(t);
  symlinkSync(resolve(import.meta.dirname, '../../pullboard.js'), join(box.env.PATH, 'pullboard'));
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { relay: { queueOnFailure: true } });
  seedCommit(box);
  const agentRoot = join(box.root, '..', 'queued-key-agent');
  const worktree = spawnSync('git', ['worktree', 'add', '-b', 'fixture-queued-key-agent', agentRoot, 'HEAD'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(worktree.status, 0, worktree.stderr);
  assert.equal((await joinFixtureSeat({ run: inProcessCli(box) }, agentRoot, box.lane)).code, 0, 'the agent worktree joins its lane');
  const prepare = await box.scriptLocal(`
    import { main } from ${JSON.stringify(box.mainURL)};
    for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
    let output = '';
    const code = await main(['shout', 'coordinator', 'Should this fixture continue?', '--kind', 'question', '--decision', '--json'], { cwd: ${JSON.stringify(agentRoot)}, stdout: { isTTY: false, write: value => { output += value; } }, stderr: { write() {} }, stdin: process.stdin });
    process.stdout.write(JSON.stringify({ code, document: JSON.parse(output) }));
  `);
  assert.equal(prepare.document.code, 0, 'the agent opens a real decision before its key is removed');
  const decision = prepare.document.document.id;
  await box.link();
  const keyText = readFileSync(box.keyFile, 'utf8').trim();
  chmodSync(box.keyFile, 0o000);
  t.after(() => { if (existsSync(box.keyFile)) chmodSync(box.keyFile, 0o600); });
  assert.throws(() => readFileSync(box.keyFile), { code: 'EACCES' }, 'the real key file is denied to this shell');
  const callsBefore = box.calls.length;
  const moves = await box.scriptLocal(`
    import { main } from ${JSON.stringify(box.mainURL)};
    for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
    /** Run one linked move and capture its JSON result. */
    async function command(cwd, args) {
      let output = '';
      try {
        const code = await main([...args, '--json'], { cwd, stdout: { isTTY: false, write: value => { output += value; } }, stderr: { write() {} }, stdin: process.stdin });
        return { code, document: output ? JSON.parse(output) : null };
      } catch (error) {
        return { code: error.code, document: { thrown: error.message } };
      }
    }
    const claim = await command(${JSON.stringify(agentRoot)}, ['claim', '1']);
    const shout = await command(${JSON.stringify(agentRoot)}, ['shout', 'all', 'queued while the key is unreadable']);
    const answer = await command(${JSON.stringify(box.root)}, ['answer', ${JSON.stringify(String(decision))}, 'yes']);
    const decisions = await command(${JSON.stringify(box.root)}, ['decisions']);
    const exported = await command(${JSON.stringify(box.root)}, ['export']);
    process.stdout.write(JSON.stringify({ claim, shout, answer, decisions, exported }));
  `);
  const file = join(dirname(box.linkFile), 'relay-outbox.unsealed.json');
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : null;
  return { moves: moves.document, decision, keyText, raw, relayCalls: box.calls.length - callsBefore };
}

test('cli.journeys-relay-outbox-auth.unreadable-key-moves-apply: clause 1: with relay.queueOnFailure on and an unreadable key, claim 1, shout all and answer yes each exit 0 and apply on the local board [C7,#9411]', async (t) => {
  const { moves, decision } = await unreadableKeyMoves(t);
  for (const name of ['claim', 'shout', 'answer']) assert.equal(moves[name].code, 0, name + ' ' + JSON.stringify(moves[name].document));
  assert.ok(!moves.decisions.document.decisions.some(ask => ask.shout_id === decision), 'the answer applied: the decision is no longer open');
  const board = JSON.stringify(moves.exported.document.tables);
  assert.ok(board.includes('queued while the key is unreadable'), 'the shout applied on the local board');
  assert.ok(moves.exported.document.tables.claim?.length > 0 || /"claim/.test(board), 'the claim applied on the local board');
});

test('cli.journeys-relay-outbox-auth.unreadable-key-moves-kept: clause 2: each of the three moves is kept in relay-outbox.unsealed.json with no key field and none reaches the relay [C7,#9411]', async (t) => {
  const { moves, keyText, raw, relayCalls } = await unreadableKeyMoves(t);
  for (const name of ['claim', 'shout', 'answer']) assert.equal(moves[name].code, 0, name + ' ' + JSON.stringify(moves[name].document));
  assert.notEqual(raw, null, 'the unsealed outbox sits beside the link file');
  const entries = JSON.parse(raw);
  assert.equal(entries.length, 3, 'one kept entry per move');
  for (const entry of entries) assert.equal(Object.hasOwn(entry, 'key'), false, 'no entry holds a key field');
  assert.equal(raw.includes(keyText), false, 'the board key text appears nowhere in the file');
  assert.equal(relayCalls, 0, 'no move reaches the relay while the key is unreadable');
});
