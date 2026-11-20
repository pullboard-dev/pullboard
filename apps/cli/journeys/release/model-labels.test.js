/** CLI model labels on every actor, with stable agent identities [O8,O3]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project } = e2e;

/** Models the rejoin cases use; named so no join call carries a literal model string. */
const CLAUDE_MODEL = 'Claude';
const OTHER_MODEL = 'Another Model';

test('cli.journeys-release-model-labels.model-names-label-cli-actors-without: model names label CLI actors without changing IDs, messages, or the context prompt [O8,O3]', async () => {
  for (const style of ['suffix', 'prefix']) {
    const box = sandbox();
    box.env.PULLBOARD_MODEL = 'Claude';
    // The shared fixture now joins web-1 with an explicit --model; this scenario needs the join to come from PULLBOARD_MODEL alone.
    const base = project('true', box, { withWorktree: false });
    const web = join(box.dir, 'web-1');
    box.git(base.repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
    assert.match(fixtureJoin(box.run, web, 'web').out, /joined as web-1/);
    const repo = { ...base, web };
    const legacyJoin = await box.inProcess(repo.web, 'whoami', '--json');
    assert.equal(legacyJoin.code, 0, legacyJoin.err || legacyJoin.out);
    assert.equal(JSON.parse(legacyJoin.out).model, 'Claude', 'the model environment identifies the initial join');

    if (style === 'suffix') {
      for (const command of ['join', 'worktree']) {
        const help = await box.inProcess(repo.repo, 'help', command);
        assert.equal(help.code, 0, help.err);
        assert.ok(help.out.includes(`Usage: pullboard ${command} <lane> --model <name>`), help.out);
        assert.match(help.out, /--model <name> — identifies the agent model; required unless PULLBOARD_MODEL is set/);
      }
    }
    delete box.env.PULLBOARD_MODEL;
    const missingWorktree = await box.inProcess(repo.repo, 'worktree', 'api', '--json');
    assert.equal(missingWorktree.code, 1);
    assert.equal(JSON.parse(missingWorktree.out).error.code, 'MODEL_REQUIRED');
    assert.equal(existsSync(join(box.dir, 'repo-api-1')), false, 'a refused worktree leaves no folder');

    const unjoined = join(box.dir, 'unjoined-web');
    box.git(repo.repo, 'worktree', 'add', '-q', '-b', 'web/unjoined', unjoined);
    const missingJoin = fixtureJoin(box.run, unjoined, 'web', '--json');
    assert.equal(missingJoin.code, 1);
    assert.equal(JSON.parse(missingJoin.out).error.code, 'MODEL_REQUIRED');

    const configFile = join(repo.repo, 'pullboard.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    config.agents = { names: style };
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    box.git(repo.repo, 'add', 'pullboard.json');
    box.git(repo.repo, 'commit', '-q', '-m', 'chore(repo): choose agent names [G1]');
    box.git(repo.web, 'merge', '-q', '--ff-only', 'main');

    const joined = fixtureJoin(box.run, repo.web, 'web', '--model', CLAUDE_MODEL, '--json');
    assert.equal(joined.code, 0, joined.err || joined.out);
    assert.equal(JSON.parse(joined.out).agent, 'web-1');
    // Rejoining with another model is refused and keeps the registered one (#2714, 04384c0971).
    const otherModel = fixtureJoin(box.run, repo.web, 'web', '--model', OTHER_MODEL, '--json');
    assert.equal(otherModel.code, 1);
    assert.equal(JSON.parse(otherModel.out).error.code, 'ALREADY_JOINED');
    const made = await box.inProcess(repo.repo, 'worktree', 'web', '--model', 'GPT 6', '--json');
    assert.equal(made.code, 0, made.err || made.out);
    const second = JSON.parse(made.out);
    assert.equal(second.agent, 'web-2');

    const builderName = style === 'suffix' ? 'web-1 (Claude)' : 'claude-web-1';
    const otherName = style === 'suffix' ? 'web-2 (GPT 6)' : 'gpt-6-web-2';
    const coordinatorName = style === 'suffix' ? 'coordinator (unknown)' : 'unknown-coordinator';
    assert.ok(second.prompt.includes(`You are ${otherName}, in the web lane.`), second.prompt);
    assert.ok(second.prompt.includes("Model: 'GPT 6'. This worktree joined with --model 'GPT 6'."), second.prompt);
    assert.ok(second.prompt.includes("pass --model 'GPT 6' or set PULLBOARD_MODEL='GPT 6'"), second.prompt);

    const wrongLane = fixtureJoin(box.run, repo.web, 'api', '--model', OTHER_MODEL);
    assert.equal(wrongLane.code, 1);
    assert.ok(wrongLane.err.includes('ALREADY_JOINED') && wrongLane.err.includes('retry with lane web and model "Claude"'), wrongLane.err);

    const selfShout = await box.inProcess(repo.web, 'shout', 'web-1', 'Keep web-1 literal');
    assert.equal(selfShout.code, 1);
    assert.ok(selfShout.err.includes(`sender ${builderName};`), selfShout.err);
    const missingReader = await box.inProcess(repo.web, 'shout', 'web-99', 'Keep web-1 literal');
    assert.equal(missingReader.code, 1);
    assert.ok(missingReader.err.includes(style === 'suffix' ? '"web-99 (unknown)"' : '"unknown-web-99"'), missingReader.err);

    const added = fixtureAdd(box.run, repo.repo, 'web', 'Model receipt', '--specs', 'G1', '--route', 'mid',
      '--criterion', 'The item can be built and checked from its brief.', '--check', 'true',
      '--brief', 'Files: web/model.js\nChange: build the fixture item\nTest: the check proves the fixture', '--json');
    assert.equal(added.code, 0, added.err || added.out);
    const id = JSON.parse(added.out).item.item_id;
    const claimed = await box.inProcess(repo.web, 'claim', String(id));
    assert.equal(claimed.code, 0, claimed.err || claimed.out);
    const held = await box.inProcess(second.path, 'claim', String(id));
    assert.equal(held.code, 1);
    assert.ok(held.err.includes(`held by ${builderName} until`), held.err);
    const structuredHeld = await box.inProcess(second.path, 'claim', String(id), '--json');
    assert.equal(JSON.parse(structuredHeld.out).error.code, 'HELD');
    assert.match(JSON.parse(structuredHeld.out).error.message, /held by web-1 until/);

    const check = await box.inProcess(repo.repo, 'check', String(id), '--yes', '--json');
    assert.equal(check.code, 0, check.err || check.out);
    assert.equal(JSON.parse(check.out).by, 'coordinator', 'the structured receipt keeps the stable actor ID');
    assert.ok(check.err.includes(`set by ${coordinatorName}: true`), check.err);
    const declinedCheck = await runCliInProcess(['check', String(id)], { cwd: second.path, env: box.env, input: 'n\n' });
    assert.equal(declinedCheck.status, 1);
    assert.ok(declinedCheck.stderr.includes(`the check set by ${coordinatorName} was not run`), declinedCheck.stderr);

    const asked = await box.inProcess(repo.repo, 'shout', 'web-1', 'Keep web-1 literal', '--decision', '--json');
    assert.equal(asked.code, 0, asked.err || asked.out);
    const ask = JSON.parse(asked.out).id;
    const wrongAnswer = await box.inProcess(second.path, 'answer', String(ask), 'wrong agent');
    assert.equal(wrongAnswer.code, 1);
    assert.ok(wrongAnswer.err.includes(`addressed to ${builderName}, not your web lane (agent ${otherName})`), wrongAnswer.err);

    assert.equal((await box.inProcess(repo.repo, 'hold', 'web', '--reason', 'Keep web-1 literal in the reason')).code, 0);
    const waiting = await box.inProcess(second.path, 'next', '--build');
    assert.equal(waiting.code, 1);
    assert.ok(waiting.err.includes(`${coordinatorName} holds the web lane: Keep web-1 literal in the reason`), waiting.err);
    assert.equal((await box.inProcess(repo.repo, 'hold', 'web', '--off')).code, 0);

    const identity = await box.inProcess(repo.web, 'whoami', '--json');
    assert.equal(identity.code, 0, identity.err || identity.out);
    assert.equal(JSON.parse(identity.out).id, 'web-1');
    assert.equal(JSON.parse(identity.out).displayName, builderName);
    const log = await box.inProcess(repo.repo, 'log', '--json');
    assert.equal(log.code, 0, log.err || log.out);
    const claim = JSON.parse(log.out).events.find((event) => event.event_kind === 'claim' && event.item_id === id);
    assert.equal(claim.event_by, 'web-1', 'event attribution stays the stable agent ID');
    assert.equal(JSON.parse(claim.event_detail).model, 'Claude');

    const statsText = await box.inProcess(repo.web, 'stats');
    assert.equal(statsText.code, 0, statsText.err || statsText.out);
    assert.ok(statsText.out.includes(`${builderName} (`), statsText.out);
    const statsJson = await box.inProcess(repo.web, 'stats', '--json');
    assert.ok(JSON.parse(statsJson.out).stats.agents.some((agent) => agent.id === 'web-1'));
    const takeover = await runCliInProcess(['takeover'], { cwd: second.path, env: { ...box.env, CODEX_THREAD_ID: 'model-label-takeover-fixture' } });
    assert.equal(takeover.status, 0, `${takeover.stdout}${takeover.stderr}`);
    assert.ok(takeover.stdout.includes(`${otherName} took over`), takeover.stdout);
    const displaced = await runCliInProcess(['shout', 'coordinator', 'Refused session'], { cwd: second.path, env: { ...box.env, CODEX_THREAD_ID: 'different-model-session-fixture' } });
    assert.equal(displaced.status, 1);
    assert.ok(displaced.stderr.includes(`belongs to ${otherName} in another agent session`), displaced.stderr);
    const judgement = await box.inProcess(second.path, 'fact', String(id), 'decision', 'Wrong actor judgement');
    assert.equal(judgement.code, 1);
    assert.ok(judgement.err.includes(`live holder (${builderName})`), judgement.err);
    const thread = await box.inProcess(repo.web, 'show', String(id));
    assert.equal(thread.code, 0, thread.err || thread.out);
    assert.ok(thread.out.includes(`  ${builderName}  claim`), thread.out);
    const decision = await box.inProcess(repo.web, 'shout', 'coordinator', 'Keep web-1 literal in question', '--kind', 'question', '--decision');
    assert.equal(decision.code, 0, decision.err || decision.out);
    const resume = await box.inProcess(repo.repo, 'resume');
    assert.equal(resume.code, 0, resume.err || resume.out);
    assert.ok(resume.out.includes(`from ${builderName} (`), resume.out);
    assert.ok(resume.out.includes('Keep web-1 literal in question'), resume.out);

    assert.equal((await box.inProcess(repo.web, 'release', String(id), '--reason', 'BLOCKED')).code, 0);
    assert.equal((await box.inProcess(repo.repo, 'hold', String(id), 'Keep web-1 literal in item reason')).code, 0);
    for (const command of [['list', 'web'], ['show', String(id)]]) {
      const heldText = await box.inProcess(repo.web, ...command);
      assert.equal(heldText.code, 0, heldText.err || heldText.out);
      assert.ok(heldText.out.includes(`held by ${coordinatorName}: Keep web-1 literal in item reason`), heldText.out);
    }
    const itemClaim = await box.inProcess(second.path, 'claim', String(id));
    assert.equal(itemClaim.code, 1);
    assert.ok(itemClaim.err.includes(`held by ${coordinatorName}: Keep web-1 literal in item reason`), itemClaim.err);
    const noFree = await box.inProcess(second.path, 'next', '--build');
    assert.equal(noFree.code, 1);
    assert.ok(noFree.err.includes('1 item is held by coordinator'), noFree.err); // next folds held reasons to a count; claim, list and show above keep the full reason
    const noFreeJson = await box.inProcess(second.path, 'next', '--build', '--json');
    assert.ok(JSON.parse(noFreeJson.out).error.message.includes('1 item is held by coordinator'));
    const available = fixtureAdd(box.run, repo.repo, 'web', 'Other model receipt', '--specs', 'G1', '--json');
    assert.equal(available.code, 0, available.err || available.out);
    const selected = await box.inProcess(second.path, 'next', '--build');
    assert.equal(selected.code, 0, selected.err || selected.out);
    assert.ok(selected.out.includes('1 item is held by coordinator'), selected.out); // next folds held reasons to a count; the full reason stays in --json below
    const freeId = JSON.parse(available.out).item.item_id;
    assert.equal((await box.inProcess(second.path, 'release', String(freeId), '--reason', 'INELIGIBLE')).code, 0);
    const selectedJson = await box.inProcess(second.path, 'next', '--build', '--json');
    // An INELIGIBLE release is never offered back to the releasing seat, even when nothing else is open (a plain cooldown falls back to it, #3014), so only the held item's count folds into the refusal.
    const selectedError = JSON.parse(selectedJson.out).error;
    assert.equal(selectedError.code, 'NOTHING_FREE');
    assert.ok(selectedError.message.includes('1 item is held by coordinator'), selectedError.message);

    // @pullboard-board-file journey: removes a stored model row from the board the CLI wrote, to replay a legacy board.
    const board = openBoard(join(repo.repo, '.git', 'pullboard', 'board.sqlite'));
    try { board.db.prepare('DELETE FROM board_meta WHERE meta_key = ?').run('agent_model:web-2'); }
    finally { store.closeBoard(board); }
    const legacy = await box.inProcess(second.path, 'whoami', '--json');
    assert.equal(legacy.code, 0, legacy.err || legacy.out);
    assert.equal(JSON.parse(legacy.out).id, 'web-2');
    assert.equal(JSON.parse(legacy.out).displayName, style === 'suffix' ? 'web-2 (unknown)' : 'unknown-web-2');
  }
});
