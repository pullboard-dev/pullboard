/** A tools folder a stopped gate still needs survives the sweep, and a retry rebuilds tools that are gone [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareDeadHandoffRetry } from '../../../../../packages/items/index.js';
import { sweepToolTrees } from '../../../../../packages/items/index.js';
import { rebuildCapturedTools } from '../../../src/io/submit/handoff.js';
import { privateFixtureFiles } from '../../fixtures/child.js';

/** Run git in a folder and return its trimmed stdout. */
function git(cwd, ...args) {
  const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

/** A fake repository common dir holding one stopped job whose worker died with the given refusal code. */
function stoppedJob(tools, code) {
  const common = privateFixtureFiles('pullboard-stopped-fixture-');
  common.write('pullboard/submit-handoffs/job-1/request.json', JSON.stringify({ job: 'job-1', tools }));
  common.write('pullboard/submit-handoffs/job-1/refusal.json', JSON.stringify({ code: 1, error: { code } }));
  return common;
}

test('clause 1: a gate worker dies, the tools folder is older than the limit, and a sweep before the retry keeps it [C7]', () => {
  const temp = privateFixtureFiles('pullboard-sweep-fixture-');
  const queue = privateFixtureFiles('pullboard-queue-fixture-');
  const old = new Date(Date.now() - 3 * 60 * 60_000);
  const tools = join(temp.root, 'pullboard-handoff-tools-job-1-abc');
  const waiting = stoppedJob(tools, 'SUBMIT_HANDOFF_DEAD');
  const finished = stoppedJob(tools, 'SOME_BUILDER_RED');
  temp.write('pullboard-handoff-tools-job-1-abc/marker', 'x');
  utimesSync(tools, old, old);
  assert.deepEqual(sweepToolTrees({ temp: temp.root, queue: queue.root, commonDirs: [waiting.root] }), [], 'a job awaiting its recovery retry keeps its tools');
  assert.ok(existsSync(tools));
  assert.deepEqual(sweepToolTrees({ temp: temp.root, queue: queue.root, commonDirs: [finished.root] }), [tools], 'a job that ended for another reason owns nothing');
});

test('clause 2: a retry whose tools are gone rebuilds them from the captured tooling commit [C7]', () => {
  const repo = privateFixtureFiles('pullboard-tools-repo-fixture-');
  repo.write('tool.txt', 'tooling\n');
  for (const args of [['init', '-q'], ['add', '.'], ['commit', '-q', '-m', 'tools']]) git(repo.root, ...args);
  const common = privateFixtureFiles('pullboard-retry-fixture-');
  const tools = join(tmpdir(), `pullboard-handoff-tools-job-2-${process.pid}-${Date.now()}`);
  const commit = 'a'.repeat(40);
  const directory = join(common.root, 'pullboard', 'submit-handoffs', 'job-2');
  common.write('pullboard/submit-handoffs/job-2/request.json', JSON.stringify({ item: 1, job: 'job-2', commonDir: common.root, commit, tools,
    toolRoot: repo.root, toolsCommit: git(repo.root, 'rev-parse', 'HEAD') }));
  let retry;
  try {
    assert.equal(existsSync(tools), false);
    assert.equal(rebuildCapturedTools(directory), true);
    retry = prepareDeadHandoffRetry(common.root, 1, { id: 'job-2', commit, tree: 't', executionCommit: commit, executionTree: 't' }, directory);
    assert.ok(existsSync(join(retry.tools, 'tool.txt')), 'the retry runs from rebuilt tools');
  } finally {
    retry?.discard();
    for (const dir of [tools, retry?.tools].filter(Boolean)) rmSync(dir, { recursive: true, force: true });
  }
});
