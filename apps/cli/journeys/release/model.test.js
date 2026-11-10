/** CLI model labels, stable agent identities, and model-free scripted tours [O8,O3,N10]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
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
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { BIN, sandbox, project } = e2e;

/** Create an empty real Git main checkout for coordinator initialization coverage. */
function coordinatorRepo(box, name) {
  const repo = join(box.dir, name);
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  return repo;
}

/** Models the rejoin cases use; named so no join call carries a literal model string. */
const CLAUDE_MODEL = 'Claude';
const OTHER_MODEL = 'Another Model';

/** Read the ordered coordinator events from the fixture's real SQLite board. */
function coordinatorEvents(repo) {
  const board = openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
  try { return store.events(board).filter(event => event.event_by === 'coordinator'); }
  finally { store.closeBoard(board); }
}

/** Read the coordinator model from the fixture's real SQLite board. */
function coordinatorModel(repo) {
  const board = openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
  try { return store.agentAt(board, repo)?.agent_model ?? null; }
  finally { store.closeBoard(board); }
}

const TOUR_STEPS = [
  '1  The person approved one spec row. The coordinator files it as work.',
  '2  A builder agent gets its own worktree in the app lane and claims the next item. Its criterion freezes.',
  '3  It writes greet(), tests the happy path and submits. Its own gate is green.',
  '4  A second agent checks out exactly that commit and tries the edge the builder skipped.',
  "5  The builder's next session starts from the board, not from memory.",
  '6  It fixes the edge, adds a test that pins it, and submits a new commit.',
  '7  The verifier breaks the fix on purpose, to prove the new test can fail, then restores it and accepts.',
  '8  The coordinator merges it. The ledger is the receipt.',
];

test('clause 1: the coordinator declares its model [O8,O3]', async (t) => {
  const box = sandbox();
  delete box.env.PULLBOARD_MODEL;

  const flaggedRepo = coordinatorRepo(box, 'init-flag');
  const flaggedInit = box.run(flaggedRepo, 'init', '--model', 'CLI Coordinator', '--json');
  assert.equal(flaggedInit.code, 0, flaggedInit.err || flaggedInit.out);
  const flaggedWho = box.run(flaggedRepo, 'whoami', '--json');
  assert.equal(flaggedWho.code, 0, flaggedWho.err || flaggedWho.out);
  const flaggedIdentity = JSON.parse(flaggedWho.out);
  assert.equal(flaggedIdentity.model, 'CLI Coordinator');
  assert.equal(flaggedIdentity.displayName, 'coordinator (CLI Coordinator)');
  const flaggedJoin = coordinatorEvents(flaggedRepo).find(event => event.event_kind === 'join');
  assert.ok(flaggedJoin, 'init records the coordinator registration');
  assert.equal(JSON.parse(flaggedJoin.event_detail).model, 'CLI Coordinator');

  const envRepo = coordinatorRepo(box, 'init-environment');
  box.env.PULLBOARD_MODEL = 'Environment Coordinator';
  const environmentInit = box.run(envRepo, 'init', '--json');
  assert.equal(environmentInit.code, 0, environmentInit.err || environmentInit.out);
  const environmentWho = box.run(envRepo, 'whoami', '--json');
  assert.equal(environmentWho.code, 0, environmentWho.err || environmentWho.out);
  const environmentIdentity = JSON.parse(environmentWho.out);
  assert.equal(environmentIdentity.model, 'Environment Coordinator');
  assert.equal(environmentIdentity.displayName, 'coordinator (Environment Coordinator)');
  const environmentJoin = coordinatorEvents(envRepo).find(event => event.event_kind === 'join');
  assert.ok(environmentJoin, 'environment-backed init records the coordinator registration');
  assert.equal(JSON.parse(environmentJoin.event_detail).model, 'Environment Coordinator');

  delete box.env.PULLBOARD_MODEL;
  const unknownRepo = coordinatorRepo(box, 'init-unknown');
  const unknownInit = box.run(unknownRepo, 'init', '--json');
  assert.equal(unknownInit.code, 0, unknownInit.err || unknownInit.out);
  const unknownWho = box.run(unknownRepo, 'whoami', '--json');
  assert.equal(unknownWho.code, 0, unknownWho.err || unknownWho.out);
  const unknownIdentity = JSON.parse(unknownWho.out);
  assert.equal(unknownIdentity.model, 'unknown');
  assert.equal(unknownIdentity.displayName, 'coordinator (unknown)');
  assert.equal(coordinatorModel(unknownRepo), null);

  const declaredRepo = coordinatorRepo(box, 'later-declaration');
  const undeclaredInit = box.run(declaredRepo, 'init');
  assert.equal(undeclaredInit.code, 0, undeclaredInit.err || undeclaredInit.out);
  const declaration = fixtureJoin(box.run, declaredRepo, 'coordinator', '--model', 'Later Coordinator', '--json');
  assert.equal(declaration.code, 0, declaration.err || declaration.out);
  const declaredIdentity = JSON.parse(declaration.out);
  assert.equal(declaredIdentity.model, 'Later Coordinator');
  assert.equal(declaredIdentity.displayName, 'coordinator (Later Coordinator)');
  const move = box.run(declaredRepo, 'shout', 'all', 'the declared coordinator acts');
  assert.equal(move.code, 0, move.err || move.out);
  const declaredEvents = coordinatorEvents(declaredRepo);
  const modelEvent = declaredEvents.find(event => event.event_kind === 'model');
  const shoutEvent = declaredEvents.find(event => event.event_kind === 'shout');
  assert.ok(modelEvent, 'the later declaration is an ordered model event');
  assert.ok(shoutEvent, 'the coordinator records a later move');
  assert.equal(JSON.parse(modelEvent.event_detail).model, 'Later Coordinator');
  assert.equal(JSON.parse(shoutEvent.event_detail).model, 'Later Coordinator');

  const canonicalRelay = await relayClientFixture(t, { coordinatorModel: null });
  assert.equal(coordinatorModel(canonicalRelay.root), null, 'the canonical coordinator begins unknown');
  await canonicalRelay.link();
  /** Count real sealed model moves, excluding checkpoint and token requests. */
  const sealedMoves = () => canonicalRelay.calls.filter(call => call.method === 'POST' && /\/moves$/u.test(call.path)).length;
  for (const [command, model] of [['join', 'Linked Join Coordinator'], ['init', 'Linked Init Coordinator']]) {
    const movesBefore = sealedMoves();
    const declared = command === 'join'
      ? await canonicalRelay.cli('join', 'coordinator', '--model', model)
      : await canonicalRelay.cli('init', '--model', model);
    assert.equal(declared.code, 0, declared.failure);
    assert.equal(sealedMoves(), movesBefore + 1, `${command}: canonical linked declaration is one sealed move`);
    const registered = coordinatorEvents(canonicalRelay.root).filter(event => event.event_kind === 'model' && JSON.parse(event.event_detail).model === model);
    assert.equal(registered.length, 1, `${command}: the linked declaration records one model event`);
    assert.equal(coordinatorModel(canonicalRelay.root), model, `${command}: the model is persisted on the linked board`);
    const acted = await canonicalRelay.cli('shout', 'all', `${model} acts`);
    assert.equal(acted.code, 0, acted.failure);
    // An export round trip through the relay orders the read after the linked shout reaches the canonical board.
    const exported = await canonicalRelay.cli('export');
    assert.equal(exported.code, 0, exported.failure);
    const latestShout = coordinatorEvents(canonicalRelay.root).filter(event => event.event_kind === 'shout').at(-1);
    assert.equal(JSON.parse(latestShout.event_detail).model, model, `${command}: later linked moves carry the declared model`);
    const canonical = exported.document.tables.agent.find(agent => agent.agent_id === 'coordinator');
    assert.equal(canonical.agent_path, canonicalRelay.root, `${command}: the canonical coordinator retains its own checkout`);
  }
  const relay = await relayClientFixture(t);
  const remoteDeclaration = await relay.cli('join', 'coordinator', '--model', 'Remote Coordinator');
  assert.equal(remoteDeclaration.code, 0, remoteDeclaration.failure);
  await relay.link();
  const pairing = await relay.cli('relay', 'pair');
  assert.equal(pairing.code, 0, `${pairing.failure}; ${pairing.document.error?.code ?? ''}`);
  delete relay.env.PULLBOARD_MODEL;
  const paired = await relay.otherDeviceJoin(pairing.document.code);
  const before = await paired.cli('export');
  assert.equal(before.code, 0, before.failure);
  const remoteCoordinator = before.document.tables.agent.find(agent => agent.agent_id === 'coordinator');
  assert.ok(remoteCoordinator, 'the linked snapshot retains the remote coordinator row');
  assert.equal(remoteCoordinator.agent_path, relay.root, 'the snapshot names the coordinator checkout on the source device');
  assert.equal(before.document.tables.board_meta.find(row => row.meta_key === 'agent_model:coordinator')?.meta_value, 'Remote Coordinator');
  /** Count real sealed moves sent to the relay, excluding checkpoint and token requests (checkpoint uploads follow 013609a3d5). */
  const remoteMoves = () => relay.calls.filter(call => call.method === 'POST' && /\/moves$/u.test(call.path)).length;
  const relayCalls = remoteMoves();
  const linkedInit = await paired.cli('init');
  assert.equal(linkedInit.code, 0, linkedInit.failure);
  assert.equal(remoteMoves(), relayCalls, 'plain linked init does not publish a coordinator registration');
  const afterPlainInit = await paired.cli('export');
  assert.equal(afterPlainInit.code, 0, afterPlainInit.failure);
  assert.deepEqual(afterPlainInit.document, before.document, 'plain linked init preserves the remote coordinator identity and path');
  const callsBeforeRefusals = remoteMoves();

  const refusal = await paired.cli('init', '--model', 'Clone Coordinator');
  assert.equal(refusal.code, 1);
  assert.equal(refusal.document.error.code, 'REMOTE_COORDINATOR_MODEL');
  assert.match(refusal.document.error.message, /the coordinator's model is declared on the coordinator's own checkout \(coordinator \(Remote Coordinator\)\)/u);
  assert.equal(refusal.document.error.message.includes('\n'), false, 'the refusal is one line');
  assert.equal(remoteMoves(), callsBeforeRefusals, 'the linked refusal does not attempt a remote registration');
  const joinRefusal = await paired.cli('join', 'coordinator', '--model', 'Clone Coordinator');
  assert.equal(joinRefusal.code, 1);
  assert.equal(joinRefusal.document.error.code, 'REMOTE_COORDINATOR_MODEL');
  assert.match(joinRefusal.document.error.message, /the coordinator's model is declared on the coordinator's own checkout \(coordinator \(Remote Coordinator\)\)/u);
  assert.equal(joinRefusal.document.error.message.includes('\n'), false, 'the linked coordinator-join refusal is one line');
  assert.equal(remoteMoves(), callsBeforeRefusals, 'the linked coordinator-join refusal does not dispatch a remote mutation');
  const after = await paired.cli('export');
  assert.equal(after.code, 0, after.failure);
  assert.deepEqual(after.document, before.document, 'linked init preserves the remote coordinator identity and path');
});

/** Return the numbered steps printed by the scripted tour. */
function tourSteps(stdout) {
  return [...stdout.matchAll(/^(\d+)  (.+)$/gmu)].map((match) => `${match[1]}  ${match[2]}`);
}

/** Create private loader fixtures that vary only the production tour module. */
function createTourVariantHarness(box) {
  const moduleUrl = new URL('../../src/io/tour.js', import.meta.url).href;
  const loader = join(box.dir, 'tour-variant-loader.mjs');
  const timerGuard = join(box.dir, 'tour-timer-guard.mjs');
  writeFileSync(loader, `
    /** Load the real tour module with one requested private test variation. */
    export async function load(url, context, nextLoad) {
      const loaded = await nextLoad(url, context);
      if (url !== process.env.PULLBOARD_TOUR_TEST_MODULE) return loaded;
      let source = String(loaded.source);
      if (process.env.PULLBOARD_TOUR_TEST_VARIANT === 'prompt') {
        const marker = '  try {\\n    mkdirSync(repo);';
        const replacement = [
          '  try {',
          "    io.say('Model name?');",
          "    let modelInput = '';",
          '    for await (const chunk of process.stdin) modelInput += chunk;',
          "    if (!modelInput.trim()) throw new TourStopped('model prompt reached EOF');",
          '    mkdirSync(repo);',
        ].join('\\n');
        if (!source.includes(marker)) throw new Error('tour prompt marker not found');
        source = source.replace(marker, replacement);
      } else if (process.env.PULLBOARD_TOUR_TEST_VARIANT === 'sleep') {
        const marker = '    pause(1200 * pace);';
        if (!source.includes(marker)) throw new Error('tour step pause marker not found');
        source = source.replace(marker, '    pause(1);\\n' + marker);
      } else {
        throw new Error('unknown private tour variant');
      }
      return { ...loaded, source };
    }
  `);
  writeFileSync(timerGuard, `
    if (process.argv[2] === 'tour') {
      const originalWait = Atomics.wait;
      /** Turn a production tour pause into a deterministic error, not elapsed time. */
      Atomics.wait = (array, index, value, timeout) => {
        if (timeout > 0) throw new Error('tour timer wait detected');
        return originalWait(array, index, value, timeout);
      };
    }
  `);
  return { loader, moduleUrl, timerGuard };
}

/** Run the real CLI tour with stdin closed and an optional private source variation. */
function runTour(box, harness, variant = '') {
  const activeHarness = harness ?? createTourVariantHarness(box);
  const env = { ...box.env, TMPDIR: box.dir, PULLBOARD_TOUR_TEST_MODULE: activeHarness.moduleUrl };
  delete env.PULLBOARD_MODEL;
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  if (variant) env.PULLBOARD_TOUR_TEST_VARIANT = variant;
  const args = ['--import', activeHarness.timerGuard];
  if (variant) args.push('--experimental-loader', activeHarness.loader);
  args.push(BIN, 'tour');
  return runFixtureChild(process.execPath, args, { cwd: box.dir, env, encoding: 'utf8', input: '' });
}

test('model names label CLI actors without changing IDs, messages, or the context prompt [O8,O3]', () => {
  for (const style of ['suffix', 'prefix']) {
    const box = sandbox();
    box.env.PULLBOARD_MODEL = 'Claude';
    // The shared fixture now joins web-1 with an explicit --model; this scenario needs the join to come from PULLBOARD_MODEL alone.
    const base = project('true', box, { withWorktree: false });
    const web = join(box.dir, 'web-1');
    box.git(base.repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
    assert.match(fixtureJoin(box.run, web, 'web').out, /joined as web-1/);
    const repo = { ...base, web };
    const legacyJoin = box.run(repo.web, 'whoami', '--json');
    assert.equal(legacyJoin.code, 0, legacyJoin.err || legacyJoin.out);
    assert.equal(JSON.parse(legacyJoin.out).model, 'Claude', 'the model environment identifies the initial join');

    if (style === 'suffix') {
      for (const command of ['join', 'worktree']) {
        const help = box.run(repo.repo, 'help', command);
        assert.equal(help.code, 0, help.err);
        assert.ok(help.out.includes(`Usage: pullboard ${command} <lane> --model <name>`), help.out);
        assert.match(help.out, /--model <name> — identifies the agent model; required unless PULLBOARD_MODEL is set/);
      }
    }
    delete box.env.PULLBOARD_MODEL;
    const missingWorktree = box.run(repo.repo, 'worktree', 'api', '--json');
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

    const wrongLane = fixtureJoin(box.run, repo.web, 'api', '--model', CLAUDE_MODEL);
    assert.equal(wrongLane.code, 1);
    assert.ok(wrongLane.err.includes('ALREADY_JOINED') && wrongLane.err.includes('retry with lane web and model "Claude"'), wrongLane.err);

    const selfShout = box.run(repo.web, 'shout', 'web-1', 'Keep web-1 literal');
    assert.equal(selfShout.code, 1);
    assert.ok(selfShout.err.includes(`sender ${builderName};`), selfShout.err);
    const missingReader = box.run(repo.web, 'shout', 'web-99', 'Keep web-1 literal');
    assert.equal(missingReader.code, 1);
    assert.ok(missingReader.err.includes(style === 'suffix' ? '"web-99 (unknown)"' : '"unknown-web-99"'), missingReader.err);

    const added = fixtureAdd(box.run, repo.repo, 'web', 'Model receipt', '--specs', 'G1', '--route', 'mid',
      '--criterion', 'The item can be built and checked from its brief.', '--check', 'true',
      '--brief', 'Files: web/model.js\nChange: build the fixture item\nTest: the check proves the fixture', '--json');
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
    const decision = box.run(repo.web, 'shout', 'coordinator', 'Keep web-1 literal in question', '--kind', 'question', '--decision');
    assert.equal(decision.code, 0, decision.err || decision.out);
    const resume = box.run(repo.repo, 'resume');
    assert.equal(resume.code, 0, resume.err || resume.out);
    assert.ok(resume.out.includes(`from ${builderName} (`), resume.out);
    assert.ok(resume.out.includes('Keep web-1 literal in question'), resume.out);

    assert.equal(box.run(repo.web, 'release', String(id), '--reason', 'BLOCKED').code, 0);
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
    assert.ok(noFree.err.includes('1 item is held by coordinator'), noFree.err); // next folds held reasons to a count; claim, list and show above keep the full reason
    const noFreeJson = box.run(second.path, 'next', '--build', '--json');
    assert.ok(JSON.parse(noFreeJson.out).error.message.includes('1 item is held by coordinator'));
    const available = fixtureAdd(box.run, repo.repo, 'web', 'Other model receipt', '--specs', 'G1', '--json');
    assert.equal(available.code, 0, available.err || available.out);
    const selected = box.run(second.path, 'next', '--build');
    assert.equal(selected.code, 0, selected.err || selected.out);
    assert.ok(selected.out.includes('1 item is held by coordinator'), selected.out); // next folds held reasons to a count; the full reason stays in --json below
    const freeId = JSON.parse(available.out).item.item_id;
    assert.equal(box.run(second.path, 'release', String(freeId), '--reason', 'BLOCKED').code, 0);
    const selectedJson = box.run(second.path, 'next', '--build', '--json');
    // The seat just released the other item, so release cooldown keeps it from this seat and only the held item's count folds into the refusal.
    const selectedError = JSON.parse(selectedJson.out).error;
    assert.equal(selectedError.code, 'NOTHING_FREE');
    assert.ok(selectedError.message.includes('1 item is held by coordinator'), selectedError.message);

    const board = openBoard(join(repo.repo, '.git', 'pullboard', 'board.sqlite'));
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
  const result = runTour(box);
  assert.deepEqual(tourSteps(result.stdout), TOUR_STEPS, result.failure ?? result.stdout);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /app-1 \(Scripted\) \$ pullboard next/);
  assert.match(result.stdout, /sent back: #1 BEHAVIOR_MISMATCH by review-1 \(Scripted\):/);
  assert.match(result.stdout, /\| 1 \| app \| Greeting \| G1 \| app-1 \(Scripted\) \| review-1 \(Scripted\) \|/);
});

test('the tour never waits on input or a timer [N10,O8]', () => {
  const box = sandbox();
  const harness = createTourVariantHarness(box);
  const prompting = runTour(box, harness, 'prompt');
  assert.equal(prompting.status, 1, `${prompting.stdout}${prompting.stderr}`);
  assert.match(prompting.stdout, /Model name\?/u);
  assert.match(prompting.stdout, /The tour stopped: model prompt reached EOF/u);
  assert.deepEqual(tourSteps(prompting.stdout), []);

  const sleeping = runTour(box, harness, 'sleep');
  assert.equal(sleeping.status, 1, `${sleeping.stdout}${sleeping.stderr}`);
  assert.match(sleeping.stderr, /tour timer wait detected/u);
  assert.notDeepEqual(tourSteps(sleeping.stdout), TOUR_STEPS, 'the timer mutant leaves the ordered tour transcript incomplete');
});
