import { landingWaiverFor as nativeLandingWaiverFor } from '../../../../packages/landing/index.js';
import { landingPorts } from '../../tests/fixtures/landing/ports.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
/** Exercise legacy waiver markers and waived submit gates against real private Git worktrees [B3,R3,C7,V4]. */
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile, BIN } = e2e;
const { FILES, landProject, itemWorktree, verifiedFour } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('a waiver after an early-stopped gate runs the gate again with legacy oversized markers [C7,V4]', () => {
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
    "    if (process.env.LAND_EARLY_STOP === '1') { console.error('Landing gate stopped early after ' + file + ': fixture failure' + ' '.repeat(300)); console.error('Files not run: ' + files.slice(count).join(', ') + ' '.repeat(300)); break; } }",
    "}",
    "console.log('1..' + count); console.log('# tests ' + count); console.log('# pass ' + (count - failed)); console.log('# fail ' + failed); process.exitCode = failed ? 1 : 0;",
  ].join('\n'));
  const entries = verifiedFour(box, { flaky: 0 });
  box.env.LAND_EARLY_STOP = '1';
  const held = json(box, box.repo, 'land');
  assert.equal(held.batch.state, 'flaky');
  assert.deepEqual(held.landed, []);
  onBoard(box, board => {
    const saved = store.landingBatches(board).find(batch => batch.id === held.batch.id);
    store.recordLandingBatch(board, { agentId: 'coordinator', revision: saved.revision,
      batch: { ...saved, gateResults: saved.gateResults.map(({ complete, requiresGreen, ...run }) => run) } });
  });
  const before = calls(box).length;
  const initial = readFileSync(held.batch.logPath, 'utf8');
  assert.ok(initial.split('\n').find(line => line.startsWith('Landing gate stopped early after ')).length > 256,
    'the early-stop marker exceeds the legacy reader line cap');
  assert.ok(initial.split('\n').find(line => line.startsWith('Files not run: ')).length > 256);
  assert.doesNotMatch(initial, /ok 2 -/u, 'later files actually did not run');
  json(box, box.repo, 'land', '--waive', FILES[0], '--until', '2099-01-01', '--reason', 'private first failure exception');
  delete box.env.LAND_EARLY_STOP;
  box.env.LAND_SUPPRESS_RED = '1';
  const result = json(box, box.repo, 'land');
  assert.deepEqual(calls(box).slice(before), [[]], 'exactly one fresh full gate runs after the waiver');
  const rerun = readFileSync(result.batch.logPath, 'utf8');
  assert.match(rerun, /ok 4 - web\/land-4/u, 'the fresh run reaches the previously untouched final file');
  assert.doesNotMatch(rerun, /stopped early|Files not run/u);
  assert.match(rerun, /# fail 0/u);
  assert.deepEqual(result.landed, entries.map(entry => entry.item));
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip);
});

test("a person's waiver lets a submit and a landing gate through only the waived test [B3,R3,C7]", () => {
  const box = landProject();
  const past = { now: () => new Date('2000-01-01T00:00:00Z') };
  const stampOf = (cwd) => {
    const stamp = join(cwd, box.git(cwd, 'rev-parse', '--git-path', 'pullboard-gate-green'));
    return existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : null;
  };
  const waived = itemWorktree(box, 1);
  assert.equal(commitFile(box, waived.path, waived.file, 'RED\n', `feat(web): build land fixture ${waived.item} [G1]`).status, 0);
  const unwaived = box.run(waived.path, 'submit', String(waived.item), '--no-next', '--json');
  assert.equal(JSON.parse(unwaived.out).error?.code, 'GATE_RED', 'an unwaived failure refuses the submission');
  onBoard(box, (board) => {
    store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'expired-submit', test: FILES[0], until: '2000-01-02', reason: 'expired submit fixture' });
    store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'expired-landing', test: FILES[1], until: '2000-01-02', reason: 'expired landing fixture' });
  }, past);
  const expired = box.run(waived.path, 'submit', String(waived.item), '--no-next', '--json');
  assert.equal(JSON.parse(expired.out).error?.code, 'GATE_RED', 'an expired waiver covers nothing');
  assert.equal(JSON.parse(box.run(waived.path, 'land', '--waive', FILES[0], '--until', '2099-01-01', '--reason', 'agent attempt', '--json').out).error?.code, 'COORDINATOR_ONLY', 'an agent seat cannot waive');
  box.env.CLAUDECODE = '1';
  assert.equal(JSON.parse(box.run(box.repo, 'land', '--waive', FILES[0], '--until', '2099-01-01', '--reason', 'agent shell attempt', '--json').out).error?.code, 'B26_PERSON_CHANNEL', 'an agent shell in the main checkout cannot waive');
  delete box.env.CLAUDECODE;
  onBoard(box, (board) => {
    const attempt = { channel: 'terminal', id: 'agent-attempt', test: FILES[0], until: '2099-01-01', reason: 'agent attempt' };
    assert.throws(() => store.recordLandingWaiver(board, { ...attempt, agentId: 'coordinator' }), /LAND_PERSON_ONLY/u);
    assert.throws(() => store.recordLandingWaiver(board, { ...attempt, agentId: 'web-1' }), /LAND_PERSON_ONLY/u);
    assert.throws(() => store.recordLandingWaiver(board, { ...attempt, agentId: 'person', channel: 'api' }), /B26_PERSON_CHANNEL/u);
    assert.equal(nativeLandingWaiverFor(board, { file: FILES[0], name: FILES[0] }, landingPorts), null, 'no attempt recorded a live waiver');
  });
  const waiver = json(box, box.repo, 'land', '--waive', FILES[0], '--until', '2099-01-01', '--reason', 'private flaky fixture tracked elsewhere').waiver;
  const line = new RegExp(`waived: .*\\(${FILES[0].replaceAll('.', '\\.')}\\) by person waiver ${waiver.id} for file ${FILES[0].replaceAll('.', '\\.')}: private flaky fixture tracked elsewhere; expires 2099-01-01T00:00:00\\.000Z`, 'u');

  const mixed = itemWorktree(box, 2);
  assert.equal(commitFile(box, mixed.path, FILES[0], 'RED\n', `feat(web): build land fixture ${mixed.item} [G1]`).status, 0);
  assert.equal(commitFile(box, mixed.path, mixed.file, 'RED\n', `feat(web): build land fixture ${mixed.item} again [G1]`).status, 0);
  const partial = box.run(mixed.path, 'submit', String(mixed.item), '--no-next', '--json');
  assert.equal(JSON.parse(partial.out).error?.code, 'GATE_RED', 'a waiver for one test never passes another failure');
  assert.equal(json(box, box.repo, 'show', String(mixed.item)).item_status, 'claimed');

  const submitted = box.run(waived.path, 'submit', String(waived.item), '--no-next');
  assert.equal(submitted.code, 0, `${submitted.err}\n${submitted.out}`);
  assert.match(submitted.out, line, 'the submission names the waiver, its reason and its expiry');
  assert.match(submitted.out, /waived, not green/u);
  assert.equal(json(box, box.repo, 'show', String(waived.item)).item_status, 'submitted');
  const facts = events(box).filter((event) => event.event_kind === 'fact' && event.item_id === waived.item).map((event) => JSON.parse(event.event_detail).text);
  assert.ok(facts.some((text) => /recorded as waived, not green/u.test(text) && line.test(text)), 'the waived submission is recorded on the item');
  assert.notEqual(stampOf(waived.path), box.git(waived.path, 'rev-parse', 'HEAD^{tree}'), 'a waived submission writes no green stamp');

  assert.equal(commitFile(box, box.repo, FILES[0], 'RED\n', 'chore: install a flaky fixture test').status, 0);
  const landing = box.run(box.repo, 'gate', '--landing');
  assert.equal(landing.code, 0, `${landing.err}\n${landing.out}`);
  assert.match(landing.out, line, 'the landing gate names the waiver, its reason and its expiry');
  assert.match(landing.out, /landing gate waived, not green/u);
  const landingJson = json(box, box.repo, 'gate', '--landing');
  assert.equal(landingJson.green, false, 'a waived landing gate is never reported green');
  assert.deepEqual(landingJson.waived.map((entry) => [entry.file, entry.waiver]), [[FILES[0], waiver.id]]);
  assert.notEqual(stampOf(box.repo), box.git(box.repo, 'rev-parse', 'HEAD^{tree}'), 'a waived landing gate writes no green stamp');

  // A separate stage that fails outside any test is never covered by a waiver for the test that also failed.
  const setup = join(box.dir, 'stage-setup.cjs');
  const runs = join(box.dir, 'stage-setup-runs');
  const broken = join(box.dir, 'stage-setup-broken');
  writeFileSync(setup, `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(runs)}, 'x'); if (fs.existsSync(${JSON.stringify(broken)})) throw new Error('separate setup stage failed');\n`);
  const configPath = join(box.repo, 'pullboard.json');
  const original = readFileSync(configPath, 'utf8');
  const gateCommand = JSON.parse(original).gate;
  const setGate = (command, message) => {
    writeFileSync(configPath, JSON.stringify({ ...JSON.parse(original), gate: command }, null, 2));
    box.git(box.repo, 'add', 'pullboard.json');
    box.git(box.repo, 'commit', '-q', '-m', message);
  };
  writeFileSync(broken, 'on\n');
  setGate(`${gateCommand}; node ${JSON.stringify(setup)}`, 'chore: run a separate setup stage after the tests');
  const staged = box.run(box.repo, 'gate', '--landing', '--json');
  assert.equal(readFileSync(runs, 'utf8').length, 1, 'the failing setup stage really ran');
  assert.equal(staged.code, 1, 'a waived test plus a separate failing stage refuses the landing gate');
  assert.equal(JSON.parse(staged.out).waived, undefined, 'a refused run names no waived failures');
  assert.doesNotMatch(staged.out, /waived, not green/u);
  const stagedItem = itemWorktree(box, 4);
  assert.equal(commitFile(box, stagedItem.path, stagedItem.file, 'PASS\n', `feat(web): build land fixture ${stagedItem.item} [G1]`).status, 0);
  const stagedSubmit = box.run(stagedItem.path, 'submit', String(stagedItem.item), '--no-next', '--json');
  assert.equal(JSON.parse(stagedSubmit.out).error?.code, 'GATE_RED', 'a waived test plus a separate failing stage refuses the submission');
  assert.equal(readFileSync(runs, 'utf8').length, 2, 'the submission ran the failing setup stage');
  assert.ok(!events(box).some((event) => event.event_kind === 'fact' && event.item_id === stagedItem.item), 'a refused submission records nothing as waived');
  rmSync(broken);
  setGate(`node ${JSON.stringify(setup)} && ${gateCommand}`, 'chore: run a passing setup stage before the tests');
  const passingStage = box.run(box.repo, 'gate', '--landing');
  assert.equal(passingStage.code, 0, `${passingStage.err}\n${passingStage.out}`);
  assert.match(passingStage.out, line, 'a passing stage leaves only the waived test to subtract');

  // A pipeline counts each component's own status: a healthy producer leaves only the waived test,
  // and a failing producer piped into the same waived TAP is its own unwaived red, at landing and at submit.
  const consumer = join(box.dir, 'pipeline-consumer.cjs');
  writeFileSync(consumer, `process.stdin.resume(); process.stdin.on('end', () => { const child = require('node:child_process').spawnSync(${JSON.stringify(gateCommand)}, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }); process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || ''); process.exitCode = child.status ?? 125; });\n`);
  setGate(`node ${JSON.stringify(setup)} | node ${JSON.stringify(consumer)}`, 'chore: pipe a setup producer into the tests');
  // The same default shell as the gate must enforce pipefail before any pipeline can run.
  // An unsupported shell must refuse even when a person waived the test printed by its consumer.
  const supportsPipefail = runFixtureChild('set -o pipefail', { cwd: box.repo, env: box.env, shell: true }).status === 0;
  if (supportsPipefail) {
    const gateLog = () => readFileSync(join(box.repo, box.git(box.repo, 'rev-parse', '--git-path', 'pullboard-gate.log')), 'utf8');
    const healthyPipe = box.run(box.repo, 'gate', '--landing');
    assert.equal(healthyPipe.code, 0, `${healthyPipe.err}\n${healthyPipe.out}`);
    assert.match(healthyPipe.out, line, 'a healthy producer leaves only the waived test to subtract');
    writeFileSync(broken, 'on\n');
    const producerRuns = readFileSync(runs, 'utf8').length;
    const failingPipe = box.run(box.repo, 'gate', '--landing', '--json');
    assert.equal(readFileSync(runs, 'utf8').length, producerRuns + 1, 'the failing producer really ran');
    assert.match(gateLog(), /Error: separate setup stage failed/u, 'the producer failed on its own');
    assert.match(gateLog(), /^# fail 1$/mu, 'the waived TAP after it is complete');
    assert.equal(failingPipe.code, 1, 'a failing producer piped into the waived tests refuses the landing gate');
    assert.equal(JSON.parse(failingPipe.out).waived, undefined, 'a refused pipeline names no waived failures');
    const pipeItem = itemWorktree(box, 3);
    assert.equal(commitFile(box, pipeItem.path, pipeItem.file, 'PASS\n', `feat(web): build land fixture ${pipeItem.item} [G1]`).status, 0);
    const failingPipeSubmit = box.run(pipeItem.path, 'submit', String(pipeItem.item), '--no-next', '--json');
    assert.equal(JSON.parse(failingPipeSubmit.out).error?.code, 'GATE_RED', 'a failing producer piped into the waived tests refuses the submission');
    assert.equal(readFileSync(runs, 'utf8').length, producerRuns + 2, 'the submission ran the failing producer');
    assert.ok(!events(box).some((event) => event.event_kind === 'fact' && event.item_id === pipeItem.item), 'a refused pipeline submission records nothing as waived');
    rmSync(broken);
    const healthyPipeSubmit = box.run(pipeItem.path, 'submit', String(pipeItem.item), '--no-next');
    assert.equal(healthyPipeSubmit.code, 0, `${healthyPipeSubmit.err}\n${healthyPipeSubmit.out}`);
    assert.match(healthyPipeSubmit.out, line, 'a healthy producer leaves only the waived test at submit');
    assert.match(healthyPipeSubmit.out, /waived, not green/u);

    // A failing component is credited only with the failures in its own output: a setup step that fails beside
    // a consumer forwarding the waived TAP is unexplained, and a TAP producer piped through cat explains itself.
    const forwarder = join(box.dir, 'pipeline-forwarder.cjs');
    writeFileSync(forwarder, `process.stdin.resume(); process.stdin.on('end', () => { const child = require('node:child_process').spawnSync(${JSON.stringify(gateCommand)}, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }); process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || ''); process.exitCode = 0; });\n`);
    setGate(`node ${JSON.stringify(setup)} | node ${JSON.stringify(forwarder)}`, 'chore: forward the waived tests behind a setup producer');
    writeFileSync(broken, 'on\n');
    const forwardRuns = readFileSync(runs, 'utf8').length;
    const forwarded = box.run(box.repo, 'gate', '--landing', '--json');
    assert.equal(readFileSync(runs, 'utf8').length, forwardRuns + 1, 'the failing setup producer really ran');
    assert.match(gateLog(), /Error: separate setup stage failed/u, 'the setup producer failed on its own');
    assert.match(gateLog(), /^# fail 1$/mu, 'the forwarded waived TAP is complete');
    assert.equal(forwarded.code, 1, 'a failing setup producer is not explained by a consumer forwarding the waived tests');
    assert.equal(JSON.parse(forwarded.out).waived, undefined, 'a forwarded account names no waived failures');
    const forwardItem = itemWorktree(box, 5, FILES[3]);
    assert.equal(commitFile(box, forwardItem.path, forwardItem.file, 'PASS\n', `feat(web): build land fixture ${forwardItem.item} [G1]`).status, 0);
    const forwardedSubmit = box.run(forwardItem.path, 'submit', String(forwardItem.item), '--no-next', '--json');
    assert.equal(JSON.parse(forwardedSubmit.out).error?.code, 'GATE_RED', 'a forwarded account refuses the submission');
    assert.equal(readFileSync(runs, 'utf8').length, forwardRuns + 2, 'the submission ran the failing setup producer');
    assert.ok(!events(box).some((event) => event.event_kind === 'fact' && event.item_id === forwardItem.item), 'a refused forwarded submission records nothing as waived');
    rmSync(broken);
    setGate(`${gateCommand} | cat`, 'chore: pipe the waived tests through cat');
    const throughCat = box.run(box.repo, 'gate', '--landing', '--json');
    assert.equal(throughCat.code, 0, `${throughCat.err}\n${throughCat.out}`);
    assert.equal(JSON.parse(throughCat.out).green, false, 'a waived pipeline is never reported green');
    assert.deepEqual(JSON.parse(throughCat.out).waived.map((entry) => [entry.file, entry.waiver]), [[FILES[0], waiver.id]], 'the TAP producer explains its own failure');
    const catItem = itemWorktree(box, 6, FILES[3]);
    assert.equal(commitFile(box, catItem.path, catItem.file, 'PASS\n', `feat(web): build land fixture ${catItem.item} [G1]`).status, 0);
    const catSubmit = box.run(catItem.path, 'submit', String(catItem.item), '--no-next');
    assert.equal(catSubmit.code, 0, `${catSubmit.err}\n${catSubmit.out}`);
    assert.match(catSubmit.out, line, 'a TAP producer piped through cat is waived at submit');
    assert.match(catSubmit.out, /waived, not green/u);
  } else {
    const setupRuns = readFileSync(runs, 'utf8');
    const refusedLanding = box.run(box.repo, 'gate', '--landing', '--json');
    assert.equal(refusedLanding.code, 1, 'a waiver never enables a pipeline without pipefail');
    const landingRefusal = JSON.parse(refusedLanding.out);
    assert.equal(landingRefusal.error?.code, 'PIPEFAIL_UNAVAILABLE');
    assert.equal(landingRefusal.waived, undefined, 'an unsupported pipeline names no waived failures');
    assert.doesNotMatch(refusedLanding.out, /waived, not green/u);
    assert.equal(readFileSync(runs, 'utf8'), setupRuns, 'an unsupported landing pipeline never starts');
    const refusedItem = itemWorktree(box, 3);
    assert.equal(commitFile(box, refusedItem.path, refusedItem.file, 'PASS\n', `feat(web): build land fixture ${refusedItem.item} [G1]`).status, 0);
    const refusedSubmit = box.run(refusedItem.path, 'submit', String(refusedItem.item), '--no-next', '--json');
    assert.equal(refusedSubmit.code, 1, 'a waiver never enables an unsupported submission pipeline');
    assert.equal(JSON.parse(refusedSubmit.out).error?.code, 'PIPEFAIL_UNAVAILABLE');
    assert.equal(readFileSync(runs, 'utf8'), setupRuns, 'an unsupported submission pipeline never starts');
    assert.equal(json(box, box.repo, 'show', String(refusedItem.item)).item_status, 'claimed');
    assert.ok(!events(box).some((event) => event.event_kind === 'fact' && event.item_id === refusedItem.item), 'an unsupported pipeline records nothing as waived');
  }

  // A real landing run does not stop early on a waived failure: every other file still runs, then the waiver subtracts it.
  const laterRan = join(box.dir, 'later-file-ran');
  const waivedFile = 'test/landing-waived.test.cjs';
  assert.equal(commitFile(box, box.repo, waivedFile, "require('node:test').test('a flaky landing check', () => { throw new Error('known flake'); });\n", 'chore: add a flaky landing test').status, 0);
  assert.equal(commitFile(box, box.repo, 'test/landing-later.test.cjs', `require('node:test').test('a later landing check', () => { require('node:fs').writeFileSync(${JSON.stringify(laterRan)}, 'ran'); });\n`, 'chore: add a later landing test').status, 0);
  setGate(`node ${JSON.stringify(join(dirname(BIN), 'run-tests.js'))} --test-concurrency=1 ${waivedFile} test/landing-later.test.cjs`, 'chore: gate with the real test runner');
  const stopped = box.run(box.repo, 'gate', '--landing');
  assert.equal(stopped.code, 1, 'an unwaived failure still stops a landing run');
  assert.match(`${stopped.out}\n${stopped.err}`, /stopped early/u);
  assert.ok(!existsSync(laterRan), 'the early stop skipped the later file');
  const runnerWaiver = json(box, box.repo, 'land', '--waive', waivedFile, '--until', '2099-01-01', '--reason', 'known landing flake').waiver;
  const continued = box.run(box.repo, 'gate', '--landing');
  assert.equal(continued.code, 0, `${continued.err}\n${continued.out}`);
  assert.ok(existsSync(laterRan), 'every other file ran past the waived failure');
  assert.doesNotMatch(`${continued.out}\n${continued.err}`, /stopped early/u);
  assert.match(continued.out, new RegExp(`waived: a flaky landing check \\(${waivedFile.replaceAll('.', '\\.')}\\) by person waiver ${runnerWaiver.id} for file `, 'u'));
  // A waiver by exact test name keeps the run going too, past the file that holds that test.
  const namedFile = 'test/landing-named.test.cjs';
  assert.equal(commitFile(box, box.repo, namedFile, "require('node:test').test('a named landing flake', () => { throw new Error('known flake'); });\n", 'chore: add a named flaky landing test').status, 0);
  setGate(`node ${JSON.stringify(join(dirname(BIN), 'run-tests.js'))} --test-concurrency=1 ${namedFile} test/landing-later.test.cjs`, 'chore: gate the named flake with the real test runner');
  const nameWaiver = json(box, box.repo, 'land', '--waive', 'a named landing flake', '--until', '2099-01-01', '--reason', 'known named flake').waiver;
  rmSync(laterRan);
  const named = box.run(box.repo, 'gate', '--landing');
  assert.equal(named.code, 0, `${named.err}\n${named.out}`);
  assert.ok(existsSync(laterRan), 'every other file ran past the failure waived by name');
  assert.doesNotMatch(`${named.out}\n${named.err}`, /stopped early/u);
  assert.match(named.out, new RegExp(`waived: a named landing flake \\(${namedFile.replaceAll('.', '\\.')}\\) by person waiver ${nameWaiver.id} for name a named landing flake: known named flake`, 'u'));
  setGate(gateCommand, 'chore: restore the single-stage gate');

  onBoard(box, (board) => {
    assert.equal(nativeLandingWaiverFor(board, { file: FILES[2], name: FILES[0] }, landingPorts), null, 'a file waiver never covers a test merely named like that file');
    store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'name-waiver', test: 'keeps a named behavior', until: '2099-01-01', reason: 'named fixture' });
    assert.equal(nativeLandingWaiverFor(board, { file: FILES[3], name: 'keeps a named behavior' }, landingPorts)?.kind, 'name');
    assert.equal(nativeLandingWaiverFor(board, { file: 'keeps a named behavior', name: 'another behavior' }, landingPorts), null, 'a name waiver covers only that name');
    assert.deepEqual(['test/my check.test.js', 'tests/check.rb', 'web/land-1.test.js', 'check.py', 'keeps a named behavior', 'parses a/b in the header'].map(store.landingWaiverKind),
      ['file', 'file', 'file', 'file', 'name', 'name'], 'paths with spaces or other languages stay file waivers');
  });
  assert.equal(commitFile(box, box.repo, FILES[2], `RED NAME:${FILES[0]}\n`, 'chore: install a test named like the waived file').status, 0);
  const spoofed = box.run(box.repo, 'gate', '--landing');
  assert.equal(spoofed.code, 1, 'a failing test named like a waived file path still refuses');
  assert.doesNotMatch(spoofed.out, /waived, not green/u);
  assert.equal(commitFile(box, box.repo, FILES[2], 'PASS\n', 'chore: correct the spoofed fixture test').status, 0);
  assert.equal(commitFile(box, box.repo, FILES[1], 'RED\n', 'chore: install a second failing fixture test').status, 0);
  const refused = box.run(box.repo, 'gate', '--landing');
  assert.equal(refused.code, 1, 'a failure with only an expired waiver refuses the landing gate');
  assert.match(refused.out, /gate red/u);
  assert.doesNotMatch(refused.out, /waived, not green/u);
});
