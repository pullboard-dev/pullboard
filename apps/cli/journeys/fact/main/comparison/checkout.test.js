/** @pullboard-test-input source-tree */
/** A main comparison ships the exact main commit from the object store and writes no working tree on this machine [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../../tests/fixtures/land/project.js';
import {
  HOST,
  installSshStandIn,
} from '../../../../tests/fixtures/runner/ssh.js';
import { runFixtureChildAsync } from '../../../../tests/fixtures/child.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject } = makeLandProjectFixtures({ ...e2e,
  sandbox(...args) { const box = e2e.sandbox(...args); box.env.PULLBOARD_MODEL = FIXTURE_MODEL; return box; } });

/** Run one real comparison through a runner stand-in while watching every main-red folder; return the result and sightings. */
async function compareOnRunner({ runner = true } = {}) {
  const box = landProject();
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/land-1.test.js'), '// RED NAME:main-red-case\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: a case already red on main');
  const worker = join(box.dir, 'runner-worker'), sshBin = join(box.dir, 'runner-bin'), remoteHome = join(box.dir, 'runner-home');
  const remoteMachine = join(remoteHome, '.pullboard'), requests = join(box.dir, 'runner-requests.jsonl'), stderrLog = join(box.dir, 'runner-stderr.log');
  const scratch = join(box.dir, 'scratch-tmp');
  for (const path of [worker, sshBin, remoteHome, remoteMachine, scratch]) mkdirSync(path, { recursive: true });
  box.env.TMPDIR = scratch;
  // The runner path is the new one; with no runner registered the same comparison runs in a full working tree here.
  if (runner) {
    installSshStandIn({ bin: sshBin, worker, home: remoteHome, machineHome: remoteMachine, requests, stderrLog });
    box.env.PATH = `${sshBin}:${box.env.PATH}`;
    writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1,
      runners: [{ host: HOST, slots: 1, browser: 1 }], gate: { runnersOnly: true, memoryFloorMB: 0 } }));
  } else {
    writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1, gate: { memoryFloorMB: 0 } }));
  }
  const main = box.git(box.repo, 'rev-parse', 'HEAD');
  const tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
  const module = pathToFileURL(resolve(import.meta.dirname, '../../../../../../packages/landing/src/io/main/red.js')).href;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', `
    import { readdirSync, realpathSync } from 'node:fs';
    import { join } from 'node:path';
    import { compareMainFailures } from ${JSON.stringify(module)};
    const base = realpathSync(${JSON.stringify(scratch)});
    const seen = { folders: 0, files: 0 };
    /** Record every file under a main-red folder other than git's own. */
    const watch = () => {
      for (const name of readdirSync(base).filter(name => name.startsWith('pullboard-main-red-'))) {
        seen.folders += 1;
        try { seen.files += readdirSync(join(base, name, 'checkout')).filter(entry => entry !== '.git').length; } catch { /* removed meanwhile */ }
      }
    };
    const timer = setInterval(watch, 10); // budget: sample the comparison's own temporary folder while the runner job runs.
    const out = await compareMainFailures(${JSON.stringify(box.repo)}, { tests: [{ file: 'web/land-1.test.js', passed: false }] }, undefined, '',
      { commit: ${JSON.stringify(main)}, detailed: true, allowCancelled: true, runnerAdmission: { runnerOnly: ${runner} } });
    clearInterval(timer);
    process.stdout.write(JSON.stringify({ out, seen }));
  `], { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 120000 }); // budget: one real runner round trip.
  assert.equal(result.status, 0, result.stderr || result.failure);
  const { out, seen } = JSON.parse(result.stdout.trim().split('\n').at(-1));
  return { box, out, seen, main, tree, scratch, requests, stderrLog };
}

const ran = compareOnRunner();

test('clause 1: a main comparison writes no working tree and the runner job records the exact main commit and tree [C7]', { timeout: 180_000 }, async () => {
  const { out, seen, main, tree, scratch, requests, stderrLog } = await ran;
  assert.equal(out.unavailable, undefined, out.unavailable);
  // A runner comparison reads main from the object store in place, so it prepares no temporary folder at all (#3323).
  assert.equal(seen.folders, 0, 'no pullboard-main-red folder was prepared');
  assert.equal(seen.files, 0, 'no file was ever written to a pullboard-main-red folder');
  assert.deepEqual(readdirSync(scratch).filter(name => name.startsWith('pullboard-main-red-')), [], 'the temporary folder is removed');
  const log = (existsSync(requests) ? readFileSync(requests, 'utf8') : '') + (existsSync(stderrLog) ? readFileSync(stderrLog, 'utf8') : '');
  assert.doesNotMatch(log, /SPEC_REFUSED/u, log);
  assert.equal(out.main, main);
  const encoded = /PULLBOARD_RUNNER_RESULT \S+ (\S+)/u.exec(log)?.[1];
  assert.ok(encoded, `the runner returned a result: ${log}`);
  const job = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  assert.equal(job.commit, main, 'the runner job records the exact main commit');
  assert.equal(job.tree, tree, 'the runner job records the exact main tree');
});

/** The cache entry a comparison recorded for the red file, read from the repository's comparison cache. */
function cachedEntry(box, main) {
  const file = readdirSync(join(box.repo, '.git', 'pullboard')).find(name => /main-red/u.test(name));
  assert.ok(file, 'a cache file is written');
  const entries = JSON.parse(readFileSync(join(box.repo, '.git', 'pullboard', file), 'utf8')).entries;
  return entries[main]?.['web/land-1.test.js'] ?? Object.values(entries).map(value => value['web/land-1.test.js']).find(Boolean);
}

/** The shape of a value: its keys and their types, receiptId reduced to whether it is a UUID. */
function shapeOf(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, key === 'receiptId' ? /^[a-f0-9-]{36}$/u.test(value) : Array.isArray(value) ? 'array' : typeof value]));
}

test('clause 2: no-checkout comparison keeps the shape landing-split-red expects [C7]', { timeout: 300_000 }, async () => {
  // Same landProject fixture and red file landing-split-red.test.js lands: once through the runner (no checkout), once in a full tree.
  const [viaRunner, viaTree] = [await ran, await compareOnRunner({ runner: false })];
  for (const run of [viaRunner, viaTree]) assert.equal(run.out.unavailable, undefined, run.out.unavailable);
  const rows = run => run.out.files.map(({ receiptId, ...row }) => ({ ...row, receiptId: typeof receiptId }));
  assert.deepEqual(rows(viaRunner), rows(viaTree), 'the returned rows match the full-tree comparison');
  const [row] = viaRunner.out.files, [base] = viaTree.out.files;
  assert.deepEqual(shapeOf(row), shapeOf(base));
  assert.deepEqual(Object.keys(row).sort(), ['failures', 'file', 'receiptId', 'result', 'signatureVersion']);
  assert.deepEqual(row.failures, base.failures);
  assert.equal(row.signatureVersion, base.signatureVersion);
  const entry = cachedEntry(viaRunner.box, viaRunner.main), baseEntry = cachedEntry(viaTree.box, viaTree.main);
  assert.deepEqual(shapeOf(entry), shapeOf(baseEntry));
  assert.deepEqual(Object.keys(entry).sort(), ['failures', 'receiptId', 'result', 'signatureVersion']);
  assert.deepEqual({ ...entry, receiptId: 0 }, { ...baseEntry, receiptId: 0 });
});
