import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { Refused } from '../../../../kernel/index.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runShell } from '../../../src/io/run/shell.js';

/** A stand-in timed shell: reads the request, writes the spool and reports a clean exit. */
const STAND_IN = `import { readFileSync, writeFileSync } from 'node:fs';
const request = JSON.parse(readFileSync(0, 'utf8'));
writeFileSync(request.outputFile, 'stand-in ran: ' + request.timeoutMs);
process.stdout.write(JSON.stringify({ status: 0 }));
`;

test('gate.io-run-timed-shell.a-timed-run-spawns-the-timedshell: clause 2: a timed run spawns the timedShell entry its caller passes [C7]', () => {
  const fixture = privateFixtureFiles('pullboard-timed-shell-');
  fixture.write('entry.mjs', STAND_IN);
  const run = runShell(fixture.root, 'echo ignored', { timeoutMs: 20_000, timedShell: join(fixture.root, 'entry.mjs') });
  assert.equal(run.isGreen, true, run.output);
  assert.match(run.output, /stand-in ran: 20000/u);
});

test('gate.io-run-timed-shell.a-timed-run-with-no-entry: clause 2: a timed run with no entry refuses and names how to pass one [C7]', () => {
  const saved = process.env.PULLBOARD_TIMED_SHELL;
  delete process.env.PULLBOARD_TIMED_SHELL;
  try {
    assert.throws(() => runShell(process.cwd(), 'echo no', { timeoutMs: 20_000 }), error => error instanceof Refused && error.code === 'TIMED_SHELL_MISSING');
  } finally { if (saved !== undefined) process.env.PULLBOARD_TIMED_SHELL = saved; }
});
