/**
 * Invariant: a submit's Authorization, cells, doctrine and static checks run as one runner job and return their artifact
 * [C7]. The controller asks each part of one shared analysis, and the shared job admits a single runner request that
 * names every part, so a submit pays one lease and one start-up and reads every part from the one artifact it returns.
 * Repro: before #3379 each part started its own lease and controller (about 11.7 s of start-up apiece); the counting
 * check fails when a part is admitted as a job of its own.
 *
 * The runner is a counting stand-in transport that answers with a result bound to the pinned commits; no host is contacted.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { from } from './kit.js';
import { hopCheck } from './kit.js';
import { scratch } from './kit.js';
import { within } from './kit.js';

const gate = await from('apps/cli/src/io/submit/gate.js');
const { remoteSubmitAnalysis } = gate;
const { sharedRemoteAnalysis } = gate;
const { policyRepository } = await from('apps/cli/tests/fixtures/board/submit.js');
const { runFixtureGit } = await from('apps/cli/tests/fixtures/child.js');

const RESULT = 'PULLBOARD_TRUSTED_RESULT ';
const PARTS = ['authorization', 'cells', 'doctrine', 'static'];

/** A runner transport that records each admitted request and returns one artifact holding every part's result. */
function standIn(box) {
  const admitted = [];
  const runOnRunnerAsync = async (_root, shell, options) => {
    admitted.push(shell);
    const value = { main: box.main, source: box.source, steps: { static: true }, cells: { moved: [] }, doctrine: [], authorization: { ok: true },
      plan: { proofFiles: ['a.test.js'] }, admission: { browser: false, gui: false } };
    const bytes = Buffer.from(`${RESULT}${JSON.stringify(value)}\n`);
    writeFileSync(options.rawOutputPath, bytes);
    return { executionRunner: 'runner-1', executionSource: { commit: box.source, tree: box.tree }, rawOutputPath: options.rawOutputPath,
      privateCheck: { receipt: { requestSha256: options.privateCheck.sha256, sourceUnchanged: true,
        phases: { check: { offset: 0, length: bytes.length, code: 0, signal: null, timedOut: false, sha256: createHash('sha256').update(bytes).digest('hex') } } } } };
  };
  return { admitted, lease: { runner: { host: 'runner-1', node: process.execPath }, source: { commit: box.source, tree: box.tree },
    executionServices: { runners: { runOnRunnerAsync } } } };
}

/** The parts one encoded runner request names: the data it carries for each. */
function requested(shell) {
  const encoded = /const ENCODED = "([^"]+)"/u.exec(shell)?.[1];
  const data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')).data;
  return PARTS.filter(part => ({ authorization: data.authorization, cells: data.inventory !== undefined, doctrine: data.doctrine, static: data.staticChecks })[part]);
}

test('authorization, cells, doctrine and static run as one runner job and return their artifact [C7]', { timeout: 120_000 }, async () => {
  const root = policyRepository(await scratch('analysis'));
  const git = (...args) => runFixtureGit(args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('config', 'pullboard.trunk', 'refs/heads/main');
  const main = git('rev-parse', 'HEAD');
  const box = { root, main, source: main, tree: git('rev-parse', 'HEAD^{tree}') };
  const runner = standIn(box);
  const request = { main, source: main, trunk: main, base: main, check: 'node --test a.test.js', criterion: 'fixture criterion', staticChecks: 'true',
    config: { affectedTests: 'node packages/gate/src/io/run/tests.js' }, readCutItems: () => [], perPart: true,
    doctrine: { mainCommit: main, commit: main, practice: {}, timeoutMs: 1000 }, authorization: { item: { item_id: 7, item_lane: 'core' } } };
  const read = sharedRemoteAnalysis(() => remoteSubmitAnalysis(root, request, runner.lease, null));
  await hopCheck('analysis-on-runner', async () => {
    const started = performance.now();
    const artifacts = await Promise.all(PARTS.map(part => read(part, new AbortController().signal)));
    const ms = performance.now() - started;
    within(runner.admitted.length === 1, 'the four parts are one runner job', { ms, measured: `${runner.admitted.length} runner jobs for ${PARTS.length} parts` });
    assert.deepEqual(requested(runner.admitted[0]), PARTS, 'that one job names every part');
    assert.ok(artifacts.every(artifact => artifact.sha256 === artifacts[0].sha256 && artifact.runner === 'runner-1'), 'every part reads the one returned artifact');
    return { ms, measured: `1 runner job for ${PARTS.length} parts, ${artifacts[0].sha256.slice(0, 12)}` };
  });
});
