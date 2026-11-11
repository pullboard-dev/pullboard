/** A runner main comparison uses the repository's own runner cache id and sends only missing objects, with no clone [C7]. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../../tests/fixtures/land/project.js';
import { HOST } from '../../../../tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../../tests/fixtures/runner/ssh.js';
import { runFixtureChildAsync } from '../../../../tests/fixtures/child.js';
import { requestFor } from '../../../../../../packages/runners/index.js';
import { privateCheckEnvelope } from '../../../../../runner/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject } = makeLandProjectFixtures({ ...e2e,
  sandbox(...args) { const box = e2e.sandbox(...args); box.env.PULLBOARD_MODEL = FIXTURE_MODEL; return box; } });

/**
 * Two real comparisons of one red file at the same main through the runner stand-in, watching for main-red folders.
 * History carries a 3 MB incompressible blob, so a whole-history pack is far over 1 MB and only a delta stays under it.
 */
async function compareTwiceOnRunner() {
  const box = landProject();
  mkdirSync(join(box.repo, 'data'), { recursive: true });
  // Hex text is incompressible to about half and names no secret pattern, so it passes the transfer scan.
  const lines = [];
  for (let index = 0; index < 24_000; index++) lines.push(randomBytes(64).toString('hex'));
  writeFileSync(join(box.repo, 'data/history.txt'), `${lines.join('\n')}\n`);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: an old large history file');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/land-1.test.js'), '// RED NAME:main-red-case\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: a case already red on main');
  const worker = join(box.dir, 'runner-worker'), sshBin = join(box.dir, 'runner-bin'), remoteHome = join(box.dir, 'runner-home');
  const remoteMachine = join(remoteHome, '.pullboard'), requests = join(box.dir, 'runner-requests.jsonl'), stderrLog = join(box.dir, 'runner-stderr.log');
  const scratch = join(box.dir, 'scratch-tmp');
  for (const path of [worker, sshBin, remoteHome, remoteMachine, scratch]) mkdirSync(path, { recursive: true });
  box.env.TMPDIR = scratch;
  installSshStandIn({ bin: sshBin, worker, home: remoteHome, machineHome: remoteMachine, requests, stderrLog });
  box.env.PATH = `${sshBin}:${box.env.PATH}`;
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1,
    runners: [{ host: HOST, slots: 1, browser: 1 }], gate: { runnersOnly: true, memoryFloorMB: 0 } }));
  const main = box.git(box.repo, 'rev-parse', 'HEAD');
  const tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
  const module = pathToFileURL(resolve(import.meta.dirname, '../../../../../../packages/landing/src/io/main/red.js')).href;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', `
    import { readdirSync, realpathSync } from 'node:fs';
    import { compareMainFailures } from ${JSON.stringify(module)};
    const base = realpathSync(${JSON.stringify(scratch)});
    let folders = 0;
    /** Count every main-red folder that exists while a comparison runs. */
    const watch = () => { folders += readdirSync(base).filter(name => name.startsWith('pullboard-main-red-')).length; };
    const timer = setInterval(watch, 10); // budget: sample the temporary directory while the runner jobs run.
    const runs = [];
    // The second run skips the comparison cache, so it really runs main again on a runner that now holds main.
    for (const options of [{}, { fresh: true, contentCache: false }]) {
      runs.push(await compareMainFailures(${JSON.stringify(box.repo)}, { tests: [{ file: 'web/land-1.test.js', passed: false }] }, undefined, '',
        { commit: ${JSON.stringify(main)}, detailed: true, allowCancelled: true, runnerAdmission: { runnerOnly: true }, ...options }));
    }
    clearInterval(timer);
    watch();
    process.stdout.write(JSON.stringify({ runs, folders }));
  `], { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 240000 }); // budget: two real runner round trips.
  assert.equal(result.status, 0, result.stderr || result.failure);
  const { runs, folders } = JSON.parse(result.stdout.trim().split('\n').at(-1));
  const log = (existsSync(requests) ? readFileSync(requests, 'utf8') : '') + (existsSync(stderrLog) ? readFileSync(stderrLog, 'utf8') : '');
  const jobs = [...log.matchAll(/PULLBOARD_RUNNER_RESULT \S+ (\S+)/gu)].map(match => JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')));
  return { box, runs, folders, jobs, log, main, tree, remoteHome };
}

/** The runner cache id a submit from this repository sends: the request built from the repository's own checkout. */
async function submitRepoId(box, main, tree) {
  const cwd = process.cwd();
  process.chdir(box.repo);
  try {
    const request = await requestFor(box.repo, 'true', { runner: { host: HOST, slots: 1, browser: 0 }, source: { commit: main, tree }, metadata: {} },
      { privateCheckEnvelope });
    try { return request.spec.repoId; } finally { request.cleanup(); }
  } finally { process.chdir(cwd); }
}

const ran = compareTwiceOnRunner();

test('clause 1: a main comparison uses the submit path\'s runner cache id and a second one ships under 1 MB [C7]', { timeout: 300_000 }, async () => {
  const { box, runs, jobs, log, main, tree, remoteHome } = await ran;
  for (const run of runs) assert.equal(run.unavailable, undefined, run.unavailable);
  for (const run of runs) assert.deepEqual(run.files.map(row => [row.file, row.result]), [['web/land-1.test.js', 'red']]);
  assert.doesNotMatch(log, /SPEC_REFUSED/u, log);
  assert.equal(jobs.length, 2, `both comparisons ran on the runner: ${log}`);
  for (const job of jobs) assert.deepEqual([job.commit, job.tree], [main, tree], 'each runner job ran the exact main commit and tree');
  const repoId = await submitRepoId(box, main, tree);
  assert.match(repoId, /^[a-f0-9]{64}$/u);
  const caches = readdirSync(join(remoteHome, '.pullboard-runner', 'repos')).filter(name => name.endsWith('.git'));
  assert.deepEqual(caches, [`${repoId}.git`], 'both comparisons used the one cache a submit from this repository uses');
  const [first, second] = jobs.map(job => job.sourcePreparation?.packBytes);
  assert.ok(first > 1024 ** 2, `the first comparison filled a cold cache with the whole history (${first} bytes)`);
  assert.ok(Number.isSafeInteger(second) && second < 1024 ** 2, `the second comparison shipped ${second} bytes`);
});

test('clause 2: a runner comparison creates no temporary main-red clone on this machine [C7]', { timeout: 300_000 }, async () => {
  const { runs, folders } = await ran;
  for (const run of runs) assert.equal(run.unavailable, undefined, run.unavailable);
  assert.equal(folders, 0, 'no pullboard-main-red folder appeared under the temporary directory');
});
