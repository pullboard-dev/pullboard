/** @pullboard-test-input apps/runner/src/io/scripts/worker.js apps/runner/src/io/worker/spec.js packages/landing/src/io/main/red.js */
/** A landing's known-main comparison reaches a real runner worker and a refused spec names its rule [C7,B3]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import {
  HOST,
  installSshStandIn,
} from '../../../tests/fixtures/runner/ssh.js';
import { resultFrom } from '../../../../../packages/runners/index.js';
import { specRefusalRule } from '../../../../runner/src/io/worker/receipt.js';
import {
  runFixtureChildAsync,
  startFixtureChild,
} from '../../../tests/fixtures/child.js';
import { SPEC_RULES } from '../../../../runner/src/io/spec.js';
import { requestFor } from '../../../../../packages/runners/index.js';
import { privateCheckEnvelope } from '../../../../runner/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject } = makeLandProjectFixtures({ ...e2e,
  sandbox(...args) { const box = e2e.sandbox(...args); box.env.PULLBOARD_MODEL = 'known-main-runner-fixture'; return box; } });

test('a refused spec reports only fixed rule text, and the controller records it [C7]', () => {
  assert.equal(specRefusalRule(new Error('invalid landing timeout')), 'invalid landing timeout');
  assert.equal(specRefusalRule(new SyntaxError('Unexpected token \'x\', "/secret/path" is not valid JSON')), 'work specification is not valid JSON');
  assert.equal(specRefusalRule(new Error('/Users/user/secret')), 'work specification could not be read');
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
  const module = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/landing/src/io/main/red.js')).href;
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

/** Send one framed spec to a real worker and return the rule line it refused with. */
async function refusalRule(spec, cwd, env) {
  const worker = startFixtureChild(process.execPath, [resolve(import.meta.dirname, '../../../../runner/src/io/scripts/worker.js')], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  worker.stderr.on('data', chunk => { stderr += chunk; });
  worker.stdin.on('error', () => {});
  const closed = new Promise(done => worker.once('close', done));
  const body = Buffer.from(JSON.stringify(spec));
  worker.stdin.write(Buffer.concat([Buffer.from(`${body.length}\n`), body]));
  const timer = setTimeout(() => worker.kill('SIGKILL'), 15000); // budget: a refusal happens before any setup.
  await closed;
  clearTimeout(timer);
  worker.stdin.destroy();
  return /^PULLBOARD_RUNNER_SPEC_RULE (.*)$/mu.exec(stderr)?.[1] ?? `no rule line: ${stderr}`;
}

test('a real worker names the camelCase field and the origin rule it refused, echoing no value [C7]', { timeout: 120_000 }, async () => {
  const box = landProject();
  const head = box.git(box.repo, 'rev-parse', 'HEAD'), tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
  const cwd = process.cwd();
  process.chdir(box.repo);
  let base;
  try {
    const request = await requestFor(box.repo, 'true', { runner: { host: HOST, slots: 1, browser: 0 }, source: { commit: head, tree }, metadata: {} },
      { privateCheckEnvelope });
    base = JSON.parse(JSON.stringify(request.spec));
    request.cleanup();
  } finally { process.chdir(cwd); }
  const secret = 'SECRET-VALUE-9f3a';
  const cases = [
    [{ repoId: secret }, 'work specification repoId is malformed'],
    [{ browserRequired: secret }, 'work specification browserRequired is not boolean'],
    [{ origin: `http://${secret}.example/x` }, 'work specification origin must be a plain https URL'],
    [{ origin: 'https://example.com/x', originBase: secret }, 'work specification originBase is malformed or has no origin'],
    [{ root: secret }, 'work specification root is not an absolute path'],
    [{ diagnostic: secret }, 'work specification diagnostic is not boolean'],
  ];
  for (const [change, expected] of cases) {
    const rule = await refusalRule({ ...base, ...change }, box.repo, box.env);
    assert.equal(rule, expected);
    assert.equal(rule.includes(secret), false);
  }
});

test('clause 1: every fixed message a worker validator throws is a listed rule [C7]', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../../../../runner/src/io/worker/spec.js'), 'utf8');
  for (const match of source.matchAll(/new Error\('([^']+)'\)/gu)) assert.ok(SPEC_RULES.has(match[1]), `unlisted rule: ${match[1]}`);
  for (const match of source.matchAll(/\['(work specification [^']+)', \(\) =>/gu)) assert.ok(SPEC_RULES.has(match[1]), `unlisted rule: ${match[1]}`);
  assert.equal(specRefusalRule(new Error('work specification repoId is malformed')), 'work specification repoId is malformed');
});
