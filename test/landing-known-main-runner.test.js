/** A landing's known-main comparison reaches a real runner worker and a refused spec names its rule [C7,B3]. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { makeLandProjectFixtures } from './land-project-fixture.js';
import { HOST, installSshStandIn } from './runner-ssh-fixture.js';
import { resultFrom } from '../packages/runners/src/shell/runner-result.js';
import { specRefusalRule } from '../apps/runner/src/shell/runner-worker-receipt.js';
import { runFixtureChildAsync } from './fixture-child.js';
import { requestFor } from '../packages/runners/src/shell/runner-request.js';
import { privateCheckEnvelope } from '../apps/runner/src/shell/runner-private-mode.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject } = makeLandProjectFixtures({ ...e2e,
  sandbox(...args) { const box = e2e.sandbox(...args); box.env.PULLBOARD_MODEL = 'known-main-runner-fixture'; return box; } });

test('a refused spec reports only fixed rule text, and the controller records it [C7]', () => {
  assert.equal(specRefusalRule(new Error('invalid landing timeout')), 'invalid landing timeout');
  assert.equal(specRefusalRule(new SyntaxError('Unexpected token \'x\', "/secret/path" is not valid JSON')), 'work specification is not valid JSON');
  assert.equal(specRefusalRule(new Error('/Users/someone/secret')), 'work specification could not be read');
  const request = { runner: { host: HOST }, spec: { id: 'a' } };
  const refusal = (() => { try { resultFrom(request, { status: 1, stdout: Buffer.alloc(0),
    stderr: 'PULLBOARD_RUNNER_SPEC_REFUSED invalid work specification\nPULLBOARD_RUNNER_SPEC_RULE invalid landing timeout\n' }, {}); } catch (error) { return error; } })();
  assert.equal(refusal.code, 'RUNNER_WORK_SPEC');
  assert.match(refusal.message, /: invalid landing timeout$/u);
  assert.equal(refusal.runnerAttempt.reason, 'invalid work specification: invalid landing timeout');
  const old = (() => { try { resultFrom(request, { status: 1, stdout: Buffer.alloc(0), stderr: 'PULLBOARD_RUNNER_SPEC_REFUSED invalid work specification\n' }, {}); } catch (error) { return error; } })();
  assert.doesNotMatch(old.message, /specification: /u);
});

test('a known-main comparison runs on a real runner worker and finds the case red on main [C7,B3]', { timeout: 180_000 }, async () => {
  const box = landProject();
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/land-1.test.js'), '// RED NAME:main-red-case\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: a case already red on main');
  const worker = join(box.dir, 'runner-worker'), sshBin = join(box.dir, 'runner-bin'), remoteHome = join(box.dir, 'runner-home');
  const remoteMachine = join(remoteHome, '.pullboard'), requests = join(box.dir, 'runner-requests.jsonl'), stderrLog = join(box.dir, 'runner-stderr.log');
  for (const path of [worker, sshBin, remoteHome, remoteMachine]) mkdirSync(path, { recursive: true });
  installSshStandIn({ bin: sshBin, worker, home: remoteHome, machineHome: remoteMachine, requests, stderrLog });
  box.env.PATH = `${sshBin}:${box.env.PATH}`;
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1,
    runners: [{ host: HOST, slots: 1, browser: 1 }], gate: { runnersOnly: true, memoryFloorMB: 0 } }));
  const main = box.git(box.repo, 'rev-parse', 'HEAD');
  const module = pathToFileURL(resolve(import.meta.dirname, '../packages/landing/src/shell/main-red.js')).href;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', `
    import { compareMainFailures } from ${JSON.stringify(module)};
    const out = await compareMainFailures(${JSON.stringify(box.repo)}, { tests: [{ file: 'web/land-1.test.js', passed: false }] }, undefined, '',
      { commit: ${JSON.stringify(main)}, detailed: true, allowCancelled: true, runnerAdmission: { runnerOnly: true } });
    process.stdout.write(JSON.stringify(out));
  `], { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 120000 }); // budget: one real runner round trip on a clean main checkout.
  assert.equal(result.status, 0, result.stderr || result.failure);
  const out = JSON.parse(result.stdout);
  const log = existsOrEmpty(requests) + existsOrEmpty(stderrLog);
  assert.doesNotMatch(log, /SPEC_REFUSED/u, `the runner refused the comparison spec: ${log}`);
  assert.equal(out.unavailable, undefined, out.unavailable);
  assert.deepEqual(out.files.map(row => [row.file, row.result]), [['web/land-1.test.js', 'red']]);
});

/** Read a fixture log that may not exist yet. */
function existsOrEmpty(path) { try { return readFileSync(path, 'utf8'); } catch { return ''; } }

test('a private check taken under a landing lease is sent as a private check, never as the landing run [C7,B3]', async () => {
  const box = landProject();
  const head = box.git(box.repo, 'rev-parse', 'HEAD'), tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
  const mode = privateCheckEnvelope({ kind: 'private-check', version: 1, install: '', check: 'true', timeoutMs: 60000, policyCommit: head,
    trunk: { ref: 'refs/heads/main', commit: head }, guard: null });
  const cwd = process.cwd();
  process.chdir(box.repo);
  try {
    const request = await requestFor(box.repo, 'true', { runner: { host: HOST, slots: 1, browser: 0 }, source: { commit: head, tree },
      metadata: { landing: true, timeoutMs: 1000, diagnostic: true, item: '0', kind: 'land-diagnostic' }, checkedSource: { commit: head, tree },
      privateCheck: mode, rawOutputPath: join(box.dir, 'raw.log'), waivers: [{ kind: 'file', test: 'web/land-1.test.js' }] }, { privateCheckEnvelope });
    try {
      // The worker refuses a trusted check that is also marked landing, a timeout without landing, or a stage marker.
      assert.equal(request.spec.landing, false, 'a trusted private check is never the landing run');
      assert.equal(request.spec.timeoutMs, undefined);
      assert.deepEqual(request.spec.waivers, []);
      assert.equal(request.spec.stageMarker, undefined);
    } finally { request.cleanup(); }
  } finally { process.chdir(cwd); }
});
