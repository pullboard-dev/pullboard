/** @pullboard-test-loads apps/cli/src/io/commands/resume.js */
/** @pullboard-test-loads apps/cli/src/io/commands/takeover.js */
/** The coordinator guide follows real board output rather than a session transcript [B3,N19]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { openBoard } from '../apps/lib/index.js';
import { createE2eHelpers } from '../apps/cli/tests/fixtures/e2e.js';
import { runFixtureChild } from '../apps/cli/tests/fixtures/child.js';

/** Require the real fixture CLI to succeed before interpreting its output. */
function command(box, cwd, ...args) {
  const result = box.run(cwd, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}\n${result.err}\n${result.out}`);
  return result.out;
}

test('the hand-off guide matches the board [B3,N19]', () => {
  const e2e = createE2eHelpers();
  try {
    const box = e2e.project('true');
    const added = JSON.parse(command(box, box.repo, 'add', 'web', 'Handoff accepted work',
      '--specs', 'G1', '--criterion', 'The committed page parses',
      '--check', 'node --check web/page.js', '--json'));
    const id = added.item.item_id;
    command(box, box.web, 'claim', String(id));
    mkdirSync(join(box.web, 'web'), { recursive: true });
    writeFileSync(join(box.web, 'web/page.js'), "export const page = 'handoff';\n");
    box.git(box.web, 'add', 'web/page.js');
    box.git(box.web, 'commit', '-q', '-m', 'feat(web): prepare handoff page [G1]');
    const accepted = box.git(box.web, 'rev-parse', 'HEAD');
    command(box, box.web, 'submit', String(id));
    box.git(box.repo, 'switch', '-q', '--detach', accepted);
    command(box, box.repo, 'verify', String(id), 'accept', '--as', 'coordinator',
      '--note', 'The exact committed page parses.');
    box.git(box.repo, 'switch', '-q', 'main');
    command(box, box.web, 'shout', 'coordinator', 'Integrating the accepted page.',
      '--evidence', 'attempt', '--outcome', 'integrating', '--item', String(id), '--commit', accepted);

    // Decisions go upward only from the lane lead, so the coordinator names the web seat lead first [B3,N19].
    const lead = JSON.parse(command(box, box.web, 'join', 'web', '--json')).agent;
    command(box, box.repo, 'lanes', 'lead', 'web', lead);
    const ask = JSON.parse(command(box, box.web, 'shout', 'coordinator',
      'Which page should follow?', '--decision', '--kind', 'decision', '--json')).id;
    const answered = JSON.parse(command(box, box.web, 'shout', 'coordinator',
      'May the checked page proceed?', '--decision', '--kind', 'decision', '--json')).id;
    command(box, box.repo, 'answer', String(answered), 'Proceed with the checked page.');
    const person = JSON.parse(command(box, box.repo, 'shout', 'person',
      'Should the release wait for another page?', '--decision', '--json')).id;

    const common = join(box.repo, '.git');
    const directory = join(common, 'pullboard', 'landings', 'handoff-fixture');
    const main = box.git(box.repo, 'rev-parse', 'main');
    const batch = { version: 1, id: 'handoff-fixture', state: 'gating', base: main, tip: accepted,
      branch: 'refs/heads/main', root: join(directory, 'worktree'),
      owner: 'outgoing-coordinator-session', logPath: join(directory, 'logs', 'batch.log'),
      items: [{ id, commit: accepted }] };
    const board = openBoard(join(common, 'pullboard', 'board.sqlite'));
    try { store.recordLandingBatch(board, { agentId: 'coordinator', batch }); }
    finally { store.closeBoard(board); }

    const text = command(box, box.repo, 'resume', '--diagnostics');
    const card = JSON.parse(command(box, box.repo, 'resume', '--diagnostics', '--json'));
    assert.ok(card.openDecisions.some(entry => entry.id === ask));
    assert.ok(card.recentAnswers.some(entry => entry.id === answered));
    assert.ok(card.personQuestions.some(entry => entry.id === person));
    assert.ok(card.verifiedNotMerged.integrating.some(entry => entry.item.item_id === id));
    assert.equal(card.landingBatches[0].owner, batch.owner);
    assert.equal(card.landingBatches[0].tip, accepted);
    assert.equal(card.landingBatches[0].logPath, batch.logPath);
    assert.equal(card.root, box.repo);
    assert.ok(existsSync(join(common, 'pullboard', 'board.sqlite')));

    const guide = readFileSync(new URL('./handoff.md', import.meta.url), 'utf8');
    for (const label of ['open decision', 'recent decision', 'waiting on the person',
      'verified, not merged', 'merges cleanly', 'conflicts', 'claimed for integration',
      'landing handoff-fixture:', 'owner outgoing-coordinator-session', 'pullboard land --adopt']) {
      assert.ok(text.includes(label), `scripted resume actually prints ${label}`);
      const documented = label.startsWith('landing ') ? 'landing <id>:'
        : label.startsWith('owner ') ? 'owner <session>' : label;
      assert.ok(guide.includes(documented), `guide describes the rendered ${documented}`);
    }
    for (const literal of ['pullboard resume --diagnostics', 'pullboard resume --json',
      'pullboard takeover', 'board.sqlite', 'landings/<id>/logs/batch.log',
      'private chat', 'durable']) assert.ok(guide.includes(literal), `guide includes ${literal}`);
    assert.ok(text.includes(batch.logPath), 'the durable batch log is printed with its owner');
    assert.ok(text.includes(box.repo), 'resume names the real checkout rather than a scratchpad');
    const noSession = box.run(box.repo, 'takeover', '--json');
    assert.equal(JSON.parse(noSession.out).error?.code, 'AGENT_SESSION',
      'the ordinary person shell cannot take over on an agent session\u2019s behalf');
    const incoming = runFixtureChild(process.execPath, [e2e.BIN, 'takeover', '--json'], {
      cwd: box.repo, env: { ...box.env, CODEX_THREAD_ID: 'handoff-guide-private-incoming' }, encoding: 'utf8',
    });
    assert.equal(incoming.status, 0, incoming.failure || incoming.stderr || incoming.stdout);
    const takeover = JSON.parse(incoming.stdout);
    assert.equal(takeover.agent, 'coordinator');
    assert.equal(takeover.path, box.repo);
    const agent = JSON.parse(command(box, box.web, 'resume', '--json'));
    assert.equal(Object.hasOwn(agent, 'landingBatches'), false,
      'an agent resume is distinct from the coordinator hand-off');
  } finally { e2e.cleanup(); }
});
