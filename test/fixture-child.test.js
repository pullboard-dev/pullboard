/** Verify fixture child failures remain actionable without leaking credentials [C7]. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { after, test } from 'node:test';
import { cleanupFixtureChildren, runFixtureChild, runFixtureChildAsync, runFixtureExecFile, runFixtureExec, startFixtureChild } from './fixture-child.js';

after(cleanupFixtureChildren);

/** Prove failed fixture children explain outcomes while redacting fixture credentials. */
test('a fixture child killed or failed names its command, signal and stderr [C7]', { timeout: 10_000 }, async () => {
  const failed = runFixtureChild(process.execPath, ['-e', "process.stderr.write('fixture stderr\\n'); process.exit(7)"], {
    encoding: 'utf8',
  });
  assert.equal(failed.status, 7, failed.failure);
  assert.match(failed.failure, /command: .*node/u);
  assert.match(failed.failure, /status: 7/u);
  assert.match(failed.failure, /elapsed: \d+ms/u);
  assert.match(failed.failure, /stderr: fixture stderr/u);

  let requestedSignal = false;
  const startedAt = performance.now();
  let readyAt = 0;
  let terminateTimer;
  const killed = await runFixtureChildAsync(process.execPath, ['-e', "console.error('sleeping child'); setInterval(() => {}, 1000)"], {
    onStderrChunk(part, child) {
      if (!readyAt && part.includes('sleeping child')) {
        readyAt = performance.now();
        terminateTimer = setTimeout(() => {
          requestedSignal = child.kill('SIGTERM');
        }, 80);
      }
    },
  });
  clearTimeout(terminateTimer);
  assert.equal(requestedSignal, true, killed.failure);
  assert.equal(killed.status, null, killed.failure);
  assert.equal(killed.signal, 'SIGTERM', killed.failure);
  assert.match(killed.failure, /command: .*setInterval/u);
  assert.match(killed.failure, /signal: SIGTERM/u);
  const elapsed = /elapsed: (\d+)ms/u.exec(killed.failure);
  assert.ok(Number(elapsed?.[1]) - (readyAt - startedAt) >= 80, killed.failure);
  assert.match(killed.failure, /stderr: sleeping child/u);

  assert.throws(() => runFixtureExecFile(process.execPath, ['-e', "console.error('exec stderr'); process.exit(6)"], { encoding: 'utf8' }),
    error => /command:/.test(error.message) && /status: 6/.test(error.message) && /stderr: exec stderr/.test(error.message));
  assert.equal(runFixtureExec('printf shell-output', { encoding: 'utf8' }), 'shell-output');
  const observed = startFixtureChild(process.execPath, ['-e', "console.error('observed stderr'); process.exit(4)"]);
  await new Promise(resolveClose => observed.once('close', resolveClose));
  assert.match(observed.fixtureFailure, /command: .*node/u);
  assert.match(observed.fixtureFailure, /status: 4/u);
  assert.match(observed.fixtureFailure, /signal: none/u);
  assert.match(observed.fixtureFailure, /elapsed: \d+ms/u);
  assert.match(observed.fixtureFailure, /stderr: observed stderr/u);
  const ignored = runFixtureChild(process.execPath, ['-e', "console.error('otherwise discarded stderr'); process.exit(5)"], { stdio: 'ignore' });
  assert.equal(ignored.stderr, null, 'ignore preserves the caller output contract');
  assert.match(ignored.failure, /stderr: otherwise discarded stderr/u);

  const pairingCode = '0123456789abcdef0123456789abcdef.ABCDEFGHIJKLMNOPQRSTUV.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
  const credentialFailure = runFixtureChild(process.execPath, ['-e', `console.error('token ps_fixtureSecret_98765 pairing-code pa_fixtureCode_12345 relay-key relay-fixture-secret-abcdef ${pairingCode}'); process.exit(2)`], {
    encoding: 'utf8', env: { ...process.env, PULLBOARD_RELAY_KEY: 'relay-fixture-secret-abcdef' },
  });
  assert.equal(credentialFailure.status, 2, credentialFailure.failure);
  assert.match(credentialFailure.failure, /stderr: token \[redacted-token\] pairing-code \[redacted-token\] relay-key \[redacted\] \[redacted-pairing-code\]/u);
  assert.doesNotMatch(credentialFailure.failure, /ps_fixtureSecret_98765|pa_fixtureCode_12345|relay-fixture-secret-abcdef|0123456789abcdef/u);
});

/** Verify an ignored failure object still leaves structured diagnostics at the helper boundary. */
test('fixture child helpers emit structured failure diagnostics [C7]', () => {
  const helperUrl = new URL('./fixture-child.js', import.meta.url).href;
  const nested = `import(${JSON.stringify(helperUrl)}).then(async ({runFixtureChild,runFixtureChildAsync}) => { runFixtureChild(process.execPath, ['-e', "console.error('nested sync stderr'); process.exit(9)"], {encoding:'utf8'}); await runFixtureChildAsync(process.execPath, ['-e', "console.error('nested async stderr'); process.exit(8)"]); });`;
  const observed = runFixtureChild(process.execPath, ['--input-type=module', '-e', nested], { encoding: 'utf8' });
  assert.equal(observed.status, 0, observed.failure);
  assert.match(observed.stderr, /command: .*node/u);
  assert.match(observed.stderr, /status: 9/u);
  assert.match(observed.stderr, /status: 8/u);
  assert.match(observed.stderr, /signal: none/u);
  assert.match(observed.stderr, /elapsed: \d+ms/u);
  assert.match(observed.stderr, /stderr: nested sync stderr/u);
  assert.match(observed.stderr, /stderr: nested async stderr/u);
});
