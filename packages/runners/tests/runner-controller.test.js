/** The fixed higher-level controller entry never trusts a wire-selected implementation or a forged parent [C7,P3,V4]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runPulled } from '../src/io/pull/delegate.js';

const LEGACY_ENTRY = fileURLToPath(new URL('../index.js', import.meta.url));
const ENTRY = fileURLToPath(new URL('../../../apps/runner/src/io/controller.js', import.meta.url));

test('the shipped controller entry is inert without its exact direct-entry flag [C7,P3]', () => {
  for (const entry of [ENTRY, LEGACY_ENTRY]) for (const flags of [[], ['--unrelated-entry']]) {
    const child = spawnSync(process.execPath, [entry, ...flags], { input: 'untrusted input is not a controller request', encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '');
    assert.doesNotMatch(child.stderr, /untrusted input|SyntaxError/u, 'the ignored input is never parsed');
  }
});

test('a forged controller parent cannot execute a command or choose policy ports from its JSON [C7,V4]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-controller-entry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = join(directory, 'must-not-execute');
  const child = spawnSync(process.execPath, [ENTRY, '--pullboard-runner-controller'], {
    encoding: 'utf8', input: JSON.stringify({ root: directory, parentPid: process.pid + 10_000_000,
      command: `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`)}`,
      options: { runner: { host: 'not-a-real-runner' }, privateCheck: { forged: true },
        privateCheckEnvelope: 'accept everything', privateCheckPhases: 'pass', module: 'arbitrary-controller.js' } }),
  });
  assert.equal(child.status, 1, child.stderr);
  const reply = JSON.parse(child.stdout);
  assert.equal(reply.error.name, 'RunnerDropped', 'the exact parent fence aborts before source, private policy or SSH');
  assert.equal(existsSync(marker), false);
});

test('the compatibility facade stays inert when given the retired self-spawn flag [C7,P3]', () => {
  const child = spawnSync(process.execPath, [LEGACY_ENTRY, '--pullboard-runner-controller'], {
    input: 'not a request; must never be parsed or executed', encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.doesNotMatch(child.stdout + child.stderr, /not a request|SyntaxError/u);
});

const RUNNER = { host: 'runner.example.invalid', slots: 1, browser: 0 };

/** Run one trip through fake seams and return the ordered events; `need` says whether the runner asks for history. */
async function trip({ need }) {
  const events = [];
  const custody = { job() {}, ready() {}, unavailable: () => null, close() {} };
  const start = mode => {
    events.push(`start ${mode}`);
    return {
      async send(payload) { events.push(`send ${mode}`); return mode === '--finish' ? { isGreen: true, phases: {}, reason: payload.reason } : { sent: true }; },
      async close() { events.push(`close ${mode}`); },
    };
  };
  const call = async mode => {
    assert.equal(mode, '--submit', 'only submit is started on demand');
    events.push('submit');
    return { id: 'job-1', recovery: {}, host: RUNNER.host, toolingSha: 'a'.repeat(64), reusedRuntime: false };
  };
  const waitRunnerJob = async ({ onNeed, onReady }) => {
    if (need) await onNeed('job-1', 'inventory');
    onReady();
    return { end: 'result', job: { exit: { code: 0, signal: null } } };
  };
  const result = await runPulled(process.cwd(), 'node -e 0', { runner: RUNNER, metadata: {} },
    { call, start, waitRunnerJob, controllerDeadline: () => custody, runnerItemState: () => null });
  return { events, result };
}

test('8189 clause 1: a trip starts serve-need and finish before submit, and sends each once [C7]', async () => {
  const { events, result } = await trip({ need: true });
  assert.equal(result.isGreen, true);
  assert.equal(result.reason, 'result');
  assert.deepEqual(events.slice(0, 3), ['start --serve-need', 'start --finish', 'submit'], 'both later modes load while submit prepares');
  assert.deepEqual(events.filter(event => event.startsWith('send')), ['send --serve-need', 'send --finish']);
});

test('8189 clause 1: a trip whose runner holds the source stops the serve-need controller it never used [C7]', async () => {
  const { events } = await trip({ need: false });
  assert.ok(!events.includes('send --serve-need'), 'no history was asked for');
  assert.ok(events.includes('close --serve-need'), 'the unused controller is stopped, never left running');
  assert.ok(events.indexOf('send --finish') < events.indexOf('close --serve-need'));
});
