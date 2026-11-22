/** @pullboard-test-input apps/runner/src/io/private/check/worker.js */
/** Real private shells preserve output and deadlines without the unrelated Sandbox startup closure [C7,V18,V2]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { privateFixtureFiles } from '../../../../../../packages/gate/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../../../packages/gate/tests/fixtures/child.js';

const ENTRY = new URL('../../../../src/io/private/check/worker.js', import.meta.url);
const LIGHT = '../../../../../../packages/sandbox/light.js';
const FULL = '../../../../../../packages/sandbox/index.js';

/** Launch actual worker bytes with real pipes and the production 100ms + 1000ms watchdog. */
function fixture(t) {
  const files = privateFixtureFiles('pullboard-private-worker-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  let serial = 0;
  /** Keep a copied worker's relative imports bound to its actual source location; observe genuine shell spawn. */
  function run(source, command, { blockFull = false, path = process.env.PATH } = {}) {
    const name = String(++serial);
    const entry = join(files.root, name + '.mjs');
    const logPath = join(files.root, name + '.log');
    const pidFile = logPath + '.pid';
    const report = join(files.root, name + '.json');
    files.write(name + '.mjs', source);
    files.write(name + '-observer.mjs', `
import { registerHooks } from 'node:module';
import { channel } from 'node:diagnostics_channel';
import { writeFileSync } from 'node:fs';
const modules = new Set();
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === ${JSON.stringify(pathToFileURL(entry).href)} && specifier.startsWith('.')) {
      return next(new URL(specifier, ${JSON.stringify(ENTRY.href)}).href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (${blockFull} && url.endsWith('/packages/sandbox/index.js')) throw new Error('unrelated Sandbox initialization unavailable');
    if (url.startsWith('file:')) modules.add(url);
    return next(url, context);
  }
});
channel('child_process').subscribe(({ process: child }) => child.once('spawn', () => {
  writeFileSync(${JSON.stringify(report)}, JSON.stringify({ shellPid: child.pid, startupMs: performance.now(), modules: [...modules].sort() }));
}));
`);
    let result;
    try {
      result = runFixtureChild(process.execPath, ['--import', join(files.root, name + '-observer.mjs'), entry], {
        cwd: files.root, env: { ...process.env, HOME: files.root, PULLBOARD_HOME: join(files.root, 'home'), PATH: path },
        input: JSON.stringify({ command, timeout: 100, pidFile, logPath }), encoding: 'utf8',
        timeout: 1100, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
      });
      return { ...result, report: existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null,
        log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : null,
        reply: result.status === 0 ? JSON.parse(result.stdout) : null };
    } finally {
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
          try { process.kill(-pid, 'SIGKILL'); } catch { /* The timed worker already stopped its private group. */ }
        }
      }
    }
  }
  return { run };
}

/** Require a real executed shell timeout, exact captured output and identical durable pipe output. */
function timed(result, output) {
  assert.equal(result.status, 0, result.failure);
  assert.equal(result.reply.executed, true);
  assert.deepEqual(result.reply.error, { code: 'ETIMEDOUT' });
  assert.equal(result.reply.signal, 'SIGKILL');
  assert.equal(result.reply.logError, null);
  assert.equal(result.reply.output, output);
  assert.equal(result.log, output);
  assert.ok(result.report.shellPid > 0);
  assert.notEqual(result.report.shellPid, process.pid);
  assert.throws(() => process.kill(result.report.shellPid, 0), { code: 'ESRCH' });
}

test('runner.worker.import-startup: clause 2: exact worker import variants report native closure and real child startup [C7]', t => {
  const box = fixture(t);
  const candidate = readFileSync(ENTRY, 'utf8');
  assert.equal(candidate.split(LIGHT).length, 2);
  const base = candidate.replace(LIGHT, FULL);
  const command = 'echo install-started; while :; do :; done';
  const before = box.run(base, command);
  const after = box.run(candidate, command);
  timed(before, 'install-started\n');
  timed(after, 'install-started\n');
  const removed = before.report.modules.filter(url => !after.report.modules.includes(url) && !url.endsWith('.mjs'));
  assert.ok(removed.length >= 1);
  assert.ok(removed.some(url => url.endsWith('/packages/sandbox/src/io/take.js')));
  const summarize = (source, result) => ({ sourceSha256: createHash('sha256').update(source).digest('hex'),
    elapsedMs: result.elapsedMs, ...result.report });
  t.diagnostic('PULLBOARD_PRIVATE_WORKER_COMPARISON ' + JSON.stringify({ base: summarize(base, before), candidate: summarize(candidate, after), removed }));
});

test('runner.worker.unrelated-startup: clause 1: unavailable unrelated Sandbox initialization cannot prevent genuine timeout stdout [C7,V18,V2]', t => {
  const box = fixture(t);
  const candidate = readFileSync(ENTRY, 'utf8');
  const command = 'echo install-started; while :; do :; done';
  const control = box.run(candidate.replace(LIGHT, FULL), command, { blockFull: true });
  assert.equal(control.status, 1);
  assert.match(control.stderr, /unrelated Sandbox initialization unavailable/);
  assert.equal(control.stdout, '');
  assert.equal(control.report, null, 'the control fails before any shell starts');
  assert.equal(control.log, null);
  timed(box.run(candidate, command, { blockFull: true }), 'install-started\n');
});

test('runner.worker.empty-timeout: clause 1: a genuine silent shell timeout retains empty output [C7,V18,V2]', t => {
  const box = fixture(t);
  timed(box.run(readFileSync(ENTRY, 'utf8'), 'while :; do :; done'), '');
});

test('runner.worker.shell-unavailable: clause 1: an unavailable shell remains an unexecuted ENOENT failure [C7,V18,V2]', t => {
  const box = fixture(t);
  const result = box.run(readFileSync(ENTRY, 'utf8'), 'echo forbidden-shell-ran', { path: '/nonexistent-private-fixture-path' });
  assert.equal(result.status, 0, result.failure);
  assert.equal(result.reply.executed, false);
  assert.deepEqual(result.reply.error, { code: 'ENOENT' });
  assert.equal(result.reply.output, '');
  assert.equal(result.log, '');
  assert.equal(result.report, null);
});
