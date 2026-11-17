/** @pullboard-test-input source-cell apps/cli */
/** The trusted analysis entry records its own start-up time as steps.startup in its result [C7,#10574]. */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ANALYSIS_ENTRY } from '../../../../src/io/submit/gate.js';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { runFixtureChild } from '../../../fixtures/child.js';
import { runFixtureGit } from '../../../fixtures/child.js';
import { runFixtureSetupGit } from '../../../fixtures/child.js';

const REPO = join(import.meta.dirname, '..', '..', '..', '..', '..', '..');
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' };

/** Write the entry the way pull.js does, beside links to this checkout's tooling, and spawn it with the same node arguments on an input that selects no part. */
function runEntry(t) {
  const root = privateFixtureFiles('analysis-startup-').root;
  const tools = privateFixtureFiles('analysis-tools-').root;
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(tools, { recursive: true, force: true }); });
  const git = (...args) => runFixtureGit(args, { cwd: root, env: ENV });
  runFixtureSetupGit(['init', '--quiet', '-b', 'main'], { cwd: root, env: ENV });
  writeFileSync(join(root, 'a.txt'), 'x\n');
  git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'one');
  const head = git('rev-parse', 'HEAD');
  for (const name of ['packages', 'apps']) symlinkSync(join(REPO, name), join(tools, name));
  writeFileSync(join(tools, 'package.json'), '{"type":"module"}\n');
  const entry = join(tools, 'pullboard-trusted-analysis.mjs');
  writeFileSync(entry, ANALYSIS_ENTRY, { flag: 'wx', mode: 0o600 });
  const started = Date.now();
  const run = runFixtureChild(process.execPath, ['--disable-warning=ExperimentalWarning', entry, root], { cwd: root, env: ENV, encoding: 'utf8', input: JSON.stringify({ main: head, source: head, parts: [] }), maxBuffer: 64 * 1024 ** 2 });
  const wall = Date.now() - started;
  assert.equal(run.status, 0, run.context);
  const line = run.stdout.split('\n').find(row => row.startsWith('PULLBOARD_TRUSTED_RESULT '));
  assert.ok(line, run.stdout + run.stderr);
  return { result: JSON.parse(line.slice('PULLBOARD_TRUSTED_RESULT '.length)), wall, head };
}

test('cli.io-submit-gate-startup.the-result-carries-steps-startup-as-a: clause 1: the result carries steps.startup as a whole number of milliseconds from process start [C7]', t => {
  const { result } = runEntry(t);
  assert.ok(Number.isInteger(result.steps.startup), JSON.stringify(result.steps));
  assert.ok(result.steps.startup > 0);
});

test('cli.io-submit-gate-startup.every-other-key-is-unchanged-and-startup: clause 2: every other key of the result is unchanged and steps.startup is no larger than the wall time around the spawn [C7]', t => {
  const { result, wall, head } = runEntry(t);
  assert.deepEqual(Object.keys(result).sort(), ['main', 'notes', 'source', 'steps']);
  assert.deepEqual(Object.keys(result.steps), ['startup']);
  assert.equal(result.main, head);
  assert.equal(result.source, head);
  assert.deepEqual(result.notes, []);
  assert.ok(result.steps.startup <= wall, `startup ${result.steps.startup} ms against ${wall} ms of wall time`);
});
