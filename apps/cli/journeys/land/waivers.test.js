import { waivedLandingProof as nativeWaivedLandingProof } from '../../../../packages/landing/index.js';
import { landingPorts } from '../../tests/fixtures/landing/ports.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { events } from '../../tests/fixtures/land/board.js';
import { calls } from '../../tests/fixtures/land/board.js';
import { json } from '../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
/** Exercise person waivers and early-stopped gates against real private Git worktrees [B3,R3,C7,V4]. */
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile, BIN } = e2e;
const { FILES, landProject, verifiedFour } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('land holds a flake without retries and person waivers cover every failure at the exact tree [B3,R3]', () => {
  const box = landProject();
  const entries = verifiedFour(box, { flaky: [0, 1] });
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  const start = calls(box).length;
  const held = json(box, box.repo, 'land');
  assert.deepEqual(held.landed, []);
  assert.equal(held.batch.state, 'flaky');
  assert.deepEqual(held.flakes.map((flake) => flake.test), FILES.slice(0, 2));
  assert.deepEqual(calls(box).slice(start), [[], ['--alone', FILES[0]], ['--alone', FILES[1]]]);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), base);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), base);
  const refused = box.run(box.repo, 'land', '--json');
  assert.equal(JSON.parse(refused.out).error?.code, 'LAND_FLAKE');
  assert.deepEqual(calls(box).slice(start), [[], ['--alone', FILES[0]], ['--alone', FILES[1]]], 'nothing retries');
  assert.equal(events(box).filter((event) => event.event_kind === 'landing_flake').length, 2);
  const flakeItem = json(box, box.repo, 'show', String(held.flakes.find((flake) => flake.test === FILES[1]).item));
  assert.match(flakeItem.item_title, /Flaky test: web\/land-2/u);
  box.env.CODEX_THREAD_ID = 'private-agent-waiver-attempt';
  const agentAttempt = box.run(box.repo, 'land', '--waive', FILES[1], '--until', '2099-01-01', '--reason', 'private fixture exception', '--json');
  assert.equal(JSON.parse(agentAttempt.out).error?.code, 'B26_PERSON_CHANNEL');
  delete box.env.CODEX_THREAD_ID;
  const waiver = json(box, box.repo, 'land', '--waive', FILES[1], '--until', '2099-01-01', '--reason', 'private fixture exception').waiver;
  assert.equal(waiver.by, 'person');
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), base, 'recording a waiver does not land');
  const partial = box.run(box.repo, 'land', '--json');
  assert.equal(JSON.parse(partial.out).error?.code, 'LAND_FLAKE', 'one waiver cannot cover the other failing test');
  assert.deepEqual(calls(box).slice(start), [[], ['--alone', FILES[0]], ['--alone', FILES[1]]], 'partial waiver permits no retry');
  const waiverZero = json(box, box.repo, 'land', '--waive', FILES[0], '--until', '2099-01-01', '--reason', 'second private fixture exception').waiver;
  const landed = json(box, box.repo, 'land');
  assert.deepEqual(landed.landed, entries.map((entry) => entry.item));
  assert.deepEqual(calls(box).slice(start), [[], ['--alone', FILES[0]], ['--alone', FILES[1]]], 'waiver uses the recorded full gate at the same exact tree without retrying');
  assert.deepEqual(landed.batch.proof.failures.map((failure) => failure.waiver), [waiverZero.id, waiver.id]);
  assert.equal(landed.batch.proof.tree, box.git(landed.batch.root, 'rev-parse', 'HEAD^{tree}'));
  assert.ok(onBoard(box, (board) => nativeWaivedLandingProof(board, landed.batch.proof.tree, landingPorts)));
  assert.equal(onBoard(box, (board) => nativeWaivedLandingProof(board, 'f'.repeat(40), landingPorts)), null, 'proof cannot cover another tree');
  const stamp = box.git(landed.batch.root, 'rev-parse', '--git-path', 'pullboard-gate-green');
  assert.ok(!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== landed.batch.proof.tree, 'red gate never writes an ordinary green stamp');
  const expired = { now: () => new Date('2099-01-02T00:00:00Z') };
  assert.equal(onBoard(box, (board) => nativeWaivedLandingProof(board, landed.batch.proof.tree, landingPorts), expired), null, 'every waiver must remain live');
  const event = events(box).find((entry) => entry.event_kind === 'landing_waiver');
  assert.equal(event.event_by, 'person');
  assert.equal(commitFile(box, box.repo, 'docs/after-land.md', 'new exact tree\n', 'chore: advance the private tree').status, 0);
  const laterTree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
  const beforeHook = calls(box).length;
  onBoard(box, (board) => {
    store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'expired-hook-proof', test: FILES[1], until: '2000-01-02', reason: 'expired proof fixture' });
    store.recordLandingBatch(board, { agentId: 'coordinator', batch: { ...landed.batch, id: 'expired-hook-batch', state: 'ready',
      base: landed.batch.tip, tip: box.git(box.repo, 'rev-parse', 'HEAD'), revision: 0,
      proof: { tree: laterTree, failures: [{ file: FILES[0], name: FILES[0], waiver: waiverZero.id }, { file: FILES[1], name: FILES[1], waiver: 'expired-hook-proof' }] } } });
  }, { now: () => new Date('2000-01-01T00:00:00Z') });
  const hook = runFixtureChild(process.execPath, [BIN, 'hook', 'pre-push'], { cwd: box.repo, env: box.env, encoding: 'utf8',
    input: `refs/heads/main ${box.git(box.repo, 'rev-parse', 'HEAD')} refs/heads/main ${landed.batch.tip}\n` });
  assert.equal(hook.status, 1, hook.stdout);
  assert.match(hook.stderr, /expired or missing person waiver/u);
  assert.equal(calls(box).length, beforeHook, 'expired proof is refused without rerunning the red gate');
});

test('a waiver after an early-stopped gate runs the gate again [C7,V4]', async (t) => {
  for (const mode of ['early green', 'early red', 'unaccounted', 'complete']) await t.test(`${mode} keeps the exact landing proof [C7,V4]`, () => {
    const box = landProject();
    const gate = join(box.dir, 'land-gate.cjs');
    writeFileSync(gate, [
      "const fs = require('node:fs'); const path = require('node:path');",
      `const calls = ${JSON.stringify(box.calls)}; const trace = ${JSON.stringify(box.trace)};`,
      "const args = process.argv.slice(2); const alone = args.includes('--alone'); fs.appendFileSync(calls, JSON.stringify(args) + '\\n');",
      "const files = alone ? args.filter(arg => arg !== '--alone') : fs.readdirSync('web').filter(name => /^land-\\d+\\.test\\.js$/.test(name)).map(name => 'web/' + name);",
      "console.log('TAP version 13'); let count = 0; let failed = 0;",
      "for (const file of files) { const text = fs.readFileSync(file, 'utf8'); count++; fs.appendFileSync(trace, JSON.stringify({ alone, file }) + '\\n');",
      "  const red = !alone && process.env.LAND_SUPPRESS_RED !== '1' && text.includes('FLAKE');",
      "  console.log((red ? 'not ok ' : 'ok ') + count + ' - ' + file + ' keeps the landed behavior');",
      "  if (red) { failed++; console.log('  ---\\n  location: ' + path.resolve(file) + ':1:1\\n  error: fixture failure\\n  ...');",
      "    if (process.env.LAND_EARLY_STOP === '1') { console.error('Landing gate stopped early after ' + file + ': fixture failure'); console.error('Files not run: ' + files.slice(count).join(', ')); break; } }",
      "}",
      "if (process.env.LAND_UNACCOUNTED === '1' && failed) process.exit(1);",
      "console.log('1..' + count); console.log('# tests ' + count); console.log('# pass ' + (count - failed)); console.log('# fail ' + failed); process.exitCode = failed ? 1 : 0;",
    ].join('\n'));
    const entries = verifiedFour(box, { flaky: 0 });
    if (mode.startsWith('early')) box.env.LAND_EARLY_STOP = '1';
    if (mode === 'unaccounted') box.env.LAND_UNACCOUNTED = '1';
    const base = box.git(box.repo, 'rev-parse', 'HEAD');
    const held = json(box, box.repo, 'land');
    assert.equal(held.batch.state, 'flaky');
    assert.deepEqual(held.landed, []);
    const before = calls(box).length;
    const initial = readFileSync(held.batch.logPath, 'utf8');
    if (mode.startsWith('early')) {
      assert.match(initial, /Landing gate stopped early/u);
      assert.ok(initial.includes(`Files not run: ${FILES.slice(1).join(', ')}`));
      assert.doesNotMatch(initial, /ok 2 -/u, 'later files actually did not run');
    } else {
      assert.doesNotMatch(initial, /stopped early|Files not run/u);
      if (mode === 'unaccounted') assert.doesNotMatch(initial, /^# fail /mu, 'the interrupted account has no positive completion footer');
    }
    json(box, box.repo, 'land', '--waive', FILES[0], '--until', '2099-01-01', '--reason', 'private first failure exception');
    delete box.env.LAND_EARLY_STOP;
    delete box.env.LAND_UNACCOUNTED;
    if (mode === 'early green' || mode === 'unaccounted') box.env.LAND_SUPPRESS_RED = '1';
    const result = json(box, box.repo, 'land');
    if (mode === 'complete') {
      assert.equal(calls(box).length, before, 'a complete recorded gate is reused after its waiver');
      assert.deepEqual(result.landed, entries.map(entry => entry.item));
    } else {
      assert.deepEqual(calls(box).slice(before), [[]], 'exactly one fresh full gate runs after the waiver');
      const rerun = readFileSync(result.batch.logPath, 'utf8');
      assert.match(rerun, /ok 4 - web\/land-4/u, 'the fresh run reaches the previously untouched final file');
      assert.doesNotMatch(rerun, /stopped early|Files not run/u);
      if (mode === 'early green' || mode === 'unaccounted') {
        assert.match(rerun, /# fail 0/u);
        assert.deepEqual(result.landed, entries.map(entry => entry.item));
        assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip);
      } else {
        assert.match(rerun, /# fail 1/u);
        assert.deepEqual(result.landed, [], 'a fresh red gate cannot borrow the earlier waived partial proof');
        assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), base);
        assert.equal(box.git(box.remote, 'rev-parse', 'main'), base);
      }
    }
  });
});
