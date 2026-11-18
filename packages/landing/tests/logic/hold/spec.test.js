/** @pullboard-test-input apps/runner/src/io/scripts/worker.js */
/** Real private worker custody: refused input must not retain an open pipe [C7]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { startFixtureChild } from '../../../../gate/tests/fixtures/child.js';

/** A fresh private environment has its own machine pool and no authority over existing workers. */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-invalid-spec-'));
  const paths = Object.fromEntries(['repo', 'bin', 'home', 'machine'].map(name => [name, join(directory, name)]));
  for (const path of Object.values(paths)) mkdirSync(path);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { PATH: `${paths.bin}:${process.env.PATH}`, HOME: paths.home,
    PULLBOARD_HOME: paths.home, PULLBOARD_MACHINE_HOME: paths.machine,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Invalid spec fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Invalid spec fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  return { directory, ...paths, env };
}

/** Wait only for this fixture-owned child; a hang fails and is cleaned up through its actual handle. */
async function closedWithin(child, milliseconds) {
  let timeout;
  try {
    return await Promise.race([
      new Promise((resolveClose, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolveClose({ code, signal }));
      }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('owned worker did not exit after refusing its spec')), milliseconds); }),
    ]);
  } finally { clearTimeout(timeout); }
}

test('landing.spec.invalid-framed-specs-exit-promptly-with: invalid framed specs exit promptly with a named refusal while controller stdin stays open [C7]', { timeout: 20000 }, async t => { // budget: three real worker startups and five-second refusal bounds, not a performance benchmark.
  const f = fixture(t);
  for (const input of ['2\n{}', 'not-a-frame\n', '1\n{']) {
    const worker = startFixtureChild(process.execPath, [resolve(import.meta.dirname, '../../../../../apps/runner/src/io/scripts/worker.js')], {
      cwd: f.repo, env: f.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    worker.stdout.on('data', chunk => { stdout += chunk; });
    worker.stderr.on('data', chunk => { stderr += chunk; });
    try {
      worker.stdin.on('error', () => {}); // A prompt refusal may close its pipe before this fixture's pending write settles.
      const ended = closedWithin(worker, 5000); // budget: a refused input has no setup or command work to wait for.
      worker.stdin.write(input); // Deliberately never end stdin: this is the original hang boundary.
      const result = await ended;
      assert.equal(result.code, 1);
      assert.equal(result.signal, null);
      assert.match(stderr, /^PULLBOARD_RUNNER_SPEC_REFUSED invalid work specification$/mu);
      assert.equal(stdout, '');
      assert.equal(stderr.includes('PULLBOARD_RUNNER_RESULT'), false, 'invalid input cannot produce an execution receipt');
      assert.equal(stderr.includes('not-a-frame'), false, 'untrusted input is never echoed');
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        const ended = new Promise(resolveClose => worker.once('close', resolveClose));
        worker.kill('SIGKILL'); // Only this fixture's own handle, after its bounded failure.
        await ended;
      }
      worker.stdin.destroy();
    }
  }
});
