/** CLI model labels, stable agent identities, and model-free scripted tours [O8,O3,N10]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { BIN, sandbox, project } = e2e;

test('model names label CLI actors without changing IDs, messages, or the context prompt [O8,O3]', () => {
  for (const style of ['suffix', 'prefix']) {
    const box = sandbox();
    box.env.PULLBOARD_MODEL = 'Test Model';
    const repo = project('true', box);
    const legacyJoin = box.run(repo.web, 'whoami', '--json');
    assert.equal(legacyJoin.code, 0, legacyJoin.err || legacyJoin.out);
    assert.equal(JSON.parse(legacyJoin.out).model, 'Test Model', 'the model environment identifies the initial join');

    delete box.env.PULLBOARD_MODEL;
    const missingWorktree = box.run(repo.repo, 'worktree', 'api', '--json');
    assert.equal(missingWorktree.code, 1);
    assert.equal(JSON.parse(missingWorktree.out).error.code, 'MODEL_REQUIRED');
    assert.equal(existsSync(join(box.dir, 'repo-api-1')), false, 'a refused worktree leaves no folder');

    const unjoined = join(box.dir, 'unjoined-web');
    box.git(repo.repo, 'worktree', 'add', '-q', '-b', 'web/unjoined', unjoined);
    const missingJoin = box.run(unjoined, 'join', 'web', '--json');
    assert.equal(missingJoin.code, 1);
    assert.equal(JSON.parse(missingJoin.out).error.code, 'MODEL_REQUIRED');

    const configFile = join(repo.repo, 'pullboard.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    config.agents = { names: style };
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    box.git(repo.repo, 'add', 'pullboard.json');
    box.git(repo.repo, 'commit', '-q', '-m', 'chore(repo): choose agent names [G1]');
    box.git(repo.web, 'merge', '-q', '--ff-only', 'main');

    const joined = box.run(repo.web, 'join', 'web', '--model', 'Claude', '--json');
    assert.equal(joined.code, 0, joined.err || joined.out);
    assert.equal(JSON.parse(joined.out).agent, 'web-1');
    const made = box.run(repo.repo, 'worktree', 'web', '--model', 'GPT 6', '--json');
    assert.equal(made.code, 0, made.err || made.out);
    const second = JSON.parse(made.out);
    assert.equal(second.agent, 'web-2');

    const builderName = style === 'suffix' ? 'web-1 (Claude)' : 'claude-web-1';
    const otherName = style === 'suffix' ? 'web-2 (GPT 6)' : 'gpt-6-web-2';
    const coordinatorName = style === 'suffix' ? 'coordinator (unknown)' : 'unknown-coordinator';
    assert.ok(second.prompt.includes(`You are ${otherName}, in the web lane.`), second.prompt);
    assert.ok(second.prompt.includes("Model: 'GPT 6'. This worktree joined with --model 'GPT 6'."), second.prompt);
    assert.ok(second.prompt.includes("pass --model 'GPT 6' or set PULLBOARD_MODEL='GPT 6'"), second.prompt);

    const wrongLane = box.run(repo.web, 'join', 'api', '--model', 'Claude');
    assert.equal(wrongLane.code, 1);
    assert.ok(wrongLane.err.includes(`this worktree is ${builderName} in the web lane`), wrongLane.err);

    const selfShout = box.run(repo.web, 'shout', 'web-1', 'Keep web-1 literal');
    assert.equal(selfShout.code, 1);
    assert.ok(selfShout.err.includes(`sender ${builderName};`), selfShout.err);
    const missingReader = box.run(repo.web, 'shout', 'web-99', 'Keep web-1 literal');
    assert.equal(missingReader.code, 1);
    assert.ok(missingReader.err.includes(style === 'suffix' ? '"web-99 (unknown)"' : '"unknown-web-99"'), missingReader.err);

    const added = box.run(repo.repo, 'add', 'web', 'Model receipt', '--specs', 'G1', '--check', 'true', '--json');
    assert.equal(added.code, 0, added.err || added.out);
    const id = JSON.parse(added.out).item.item_id;
    const claimed = box.run(repo.web, 'claim', String(id));
    assert.equal(claimed.code, 0, claimed.err || claimed.out);
    const held = box.run(second.path, 'claim', String(id));
    assert.equal(held.code, 1);
    assert.ok(held.err.includes(`held by ${builderName} until`), held.err);
    const structuredHeld = box.run(second.path, 'claim', String(id), '--json');
    assert.equal(JSON.parse(structuredHeld.out).error.code, 'HELD');
    assert.match(JSON.parse(structuredHeld.out).error.message, /held by web-1 until/);

    const check = box.run(repo.repo, 'check', String(id), '--yes', '--json');
    assert.equal(check.code, 0, check.err || check.out);
    assert.equal(JSON.parse(check.out).by, 'coordinator', 'the structured receipt keeps the stable actor ID');
    assert.ok(check.err.includes(`set by ${coordinatorName}: true`), check.err);
    const declinedCheck = spawnSync(process.execPath, [BIN, 'check', String(id)], {
      cwd: second.path, env: box.env, encoding: 'utf8', input: 'n\n',
    });
    assert.equal(declinedCheck.status, 1);
    assert.ok(declinedCheck.stderr.includes(`the check set by ${coordinatorName} was not run`), declinedCheck.stderr);

    const asked = box.run(repo.repo, 'shout', 'web-1', 'Keep web-1 literal', '--decision', '--json');
    assert.equal(asked.code, 0, asked.err || asked.out);
    const ask = JSON.parse(asked.out).id;
    const wrongAnswer = box.run(second.path, 'answer', String(ask), 'wrong agent');
    assert.equal(wrongAnswer.code, 1);
    assert.ok(wrongAnswer.err.includes(`addressed to ${builderName}, not your web lane (agent ${otherName})`), wrongAnswer.err);

    assert.equal(box.run(repo.repo, 'hold', 'web', '--reason', 'Keep web-1 literal in the reason').code, 0);
    const waiting = box.run(second.path, 'next', '--build');
    assert.equal(waiting.code, 1);
    assert.ok(waiting.err.includes(`${coordinatorName} holds the web lane: Keep web-1 literal in the reason`), waiting.err);
    assert.equal(box.run(repo.repo, 'hold', 'web', '--off').code, 0);

    const identity = box.run(repo.web, 'whoami', '--json');
    assert.equal(identity.code, 0, identity.err || identity.out);
    assert.equal(JSON.parse(identity.out).id, 'web-1');
    assert.equal(JSON.parse(identity.out).displayName, builderName);
    const log = box.run(repo.repo, 'log', '--json');
    assert.equal(log.code, 0, log.err || log.out);
    const claim = JSON.parse(log.out).events.find((event) => event.event_kind === 'claim' && event.item_id === id);
    assert.equal(claim.event_by, 'web-1', 'event attribution stays the stable agent ID');
    assert.equal(JSON.parse(claim.event_detail).model, 'Claude');

    const statsText = box.run(repo.web, 'stats');
    assert.equal(statsText.code, 0, statsText.err || statsText.out);
    assert.ok(statsText.out.includes(`${builderName} (`), statsText.out);
    const statsJson = box.run(repo.web, 'stats', '--json');
    assert.ok(JSON.parse(statsJson.out).stats.agents.some((agent) => agent.id === 'web-1'));
    const takeover = runFixtureChild(process.execPath, [BIN, 'takeover'], {
      cwd: second.path, env: { ...box.env, CODEX_THREAD_ID: 'model-label-takeover-fixture' }, encoding: 'utf8',
    });
    assert.equal(takeover.status, 0, `${takeover.stdout}${takeover.stderr}`);
    assert.ok(takeover.stdout.includes(`${otherName} took over`), takeover.stdout);
    const displaced = runFixtureChild(process.execPath, [BIN, 'shout', 'coordinator', 'Refused session'], {
      cwd: second.path, env: { ...box.env, CODEX_THREAD_ID: 'different-model-session-fixture' }, encoding: 'utf8',
    });
    assert.equal(displaced.status, 1);
    assert.ok(displaced.stderr.includes(`belongs to ${otherName} in another agent session`), displaced.stderr);
    const judgement = box.run(second.path, 'fact', String(id), 'decision', 'Wrong actor judgement');
    assert.equal(judgement.code, 1);
    assert.ok(judgement.err.includes(`live holder (${builderName})`), judgement.err);
    const thread = box.run(repo.web, 'show', String(id));
    assert.equal(thread.code, 0, thread.err || thread.out);
    assert.ok(thread.out.includes(`  ${builderName}  claim`), thread.out);
    const decision = box.run(repo.web, 'shout', 'coordinator', 'Keep web-1 literal in question', '--decision');
    assert.equal(decision.code, 0, decision.err || decision.out);
    const resume = box.run(repo.repo, 'resume');
    assert.equal(resume.code, 0, resume.err || resume.out);
    assert.ok(resume.out.includes(`from ${builderName} (`), resume.out);
    assert.ok(resume.out.includes('Keep web-1 literal in question'), resume.out);

    assert.equal(box.run(repo.web, 'release', String(id)).code, 0);
    assert.equal(box.run(repo.repo, 'hold', String(id), 'Keep web-1 literal in item reason').code, 0);
    for (const command of [['list', 'web'], ['show', String(id)]]) {
      const heldText = box.run(repo.web, ...command);
      assert.equal(heldText.code, 0, heldText.err || heldText.out);
      assert.ok(heldText.out.includes(`held by ${coordinatorName}: Keep web-1 literal in item reason`), heldText.out);
    }
    const itemClaim = box.run(second.path, 'claim', String(id));
    assert.equal(itemClaim.code, 1);
    assert.ok(itemClaim.err.includes(`held by ${coordinatorName}: Keep web-1 literal in item reason`), itemClaim.err);
    const noFree = box.run(second.path, 'next', '--build');
    assert.equal(noFree.code, 1);
    assert.ok(noFree.err.includes(`#${id} is held by ${coordinatorName}: Keep web-1 literal in item reason`), noFree.err);
    const noFreeJson = box.run(second.path, 'next', '--build', '--json');
    assert.ok(JSON.parse(noFreeJson.out).error.message.includes(`#${id} is held by coordinator: Keep web-1 literal in item reason`));
    const available = box.run(repo.repo, 'add', 'web', 'Other model receipt', '--specs', 'G1', '--json');
    assert.equal(available.code, 0, available.err || available.out);
    const selected = box.run(second.path, 'next', '--build');
    assert.equal(selected.code, 0, selected.err || selected.out);
    assert.ok(selected.out.includes(`#${id} is held by ${coordinatorName}: Keep web-1 literal in item reason`), selected.out);
    const freeId = JSON.parse(available.out).item.item_id;
    assert.equal(box.run(second.path, 'release', String(freeId)).code, 0);
    const selectedJson = box.run(second.path, 'next', '--build', '--json');
    assert.ok(JSON.parse(selectedJson.out).reasons.includes(`#${id} is held by coordinator: Keep web-1 literal in item reason`));

    const board = store.openBoard(join(repo.repo, '.git', 'pullboard', 'board.sqlite'));
    try { board.db.prepare('DELETE FROM board_meta WHERE meta_key = ?').run('agent_model:web-2'); }
    finally { store.closeBoard(board); }
    const legacy = box.run(second.path, 'whoami', '--json');
    assert.equal(legacy.code, 0, legacy.err || legacy.out);
    assert.equal(JSON.parse(legacy.out).id, 'web-2');
    assert.equal(JSON.parse(legacy.out).displayName, style === 'suffix' ? 'web-2 (unknown)' : 'unknown-web-2');
  }
});

test('the scripted tour names its model without PULLBOARD_MODEL [N10,O8]', () => {
  const box = sandbox();
  const env = { ...box.env, TMPDIR: box.dir };
  delete env.PULLBOARD_MODEL;
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  const startedAt = Date.now();
  const result = runFixtureChild(process.execPath, [BIN, 'tour'], { cwd: box.dir, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.ok(Date.now() - startedAt < 30_000, 'the tour remains a short scripted example');
  assert.match(result.stdout, /app-1 \(Scripted\) \$ pullboard next/);
  assert.match(result.stdout, /sent back: #1 BEHAVIOR_MISMATCH by review-1 \(Scripted\):/);
  assert.match(result.stdout, /\| 1 \| app \| Greeting \| G1 \| app-1 \(Scripted\) \| review-1 \(Scripted\) \|/);
});
