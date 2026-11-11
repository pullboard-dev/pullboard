import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
/** Build one committed probe that observes the actual checkout and remote process environment. */
export function writeProbe(repo, { remoteStateRoot, remoteMachineHome, sourceHome, sourceMachineHome, callerPool, callerToken,
  historyBaseCommit, annotatedTagObject, lightweightTagObject, batchTagObjects = [] }) {
  const probe = `import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
test('runner executed the committed source in its private checkout', () => {
  assert.equal(readFileSync('empty.bin').length, 0, 'an empty blob preserves the next object boundary');
  assert.deepEqual(readFileSync('binary.bin'), Buffer.from([0, 10, 255, 13, 0, 128]), 'binary framing preserves exact bytes');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim();
  const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
  const history = execFileSync('git', ['log', '--follow', '--format=%H', '--', 'history-renamed.txt'], { encoding: 'utf8' }).trim().split(/\\r?\\n/u);
  const runnerHome = process.env.HOME;
  const privateHomeRelative = relative(${JSON.stringify(remoteStateRoot)}, runnerHome);
  assert.ok(privateHomeRelative && !privateHomeRelative.startsWith('..' + sep) && privateHomeRelative !== '..', runnerHome);
  const checkoutRelative = relative(${JSON.stringify(remoteStateRoot)}, process.cwd());
  assert.equal(checkoutRelative.split(sep)[0], 'jobs', checkoutRelative);
  assert.notEqual(process.cwd(), ${JSON.stringify(sourceHome)});
  assert.ok(checkoutRelative && !checkoutRelative.startsWith('..' + sep) && checkoutRelative !== '..', process.cwd());
  assert.ok(isAbsolute(process.env.HOME));
  assert.equal(relative(process.cwd(), runnerHome), join('..', 'home'));
  assert.equal(process.env.PULLBOARD_MACHINE_HOME, ${JSON.stringify(remoteMachineHome)});
  assert.equal(shallow, 'false', 'the worker receives full selected-candidate history');
  assert.equal(count, '3', 'the full selected candidate has the fixture base, rename, and probe commits');
  assert.ok(history.includes(${JSON.stringify(historyBaseCommit)}), 'the rename retains its original committed file in history');
  assert.equal(execFileSync('git', ['rev-parse', 'refs/tags/runner-release'], { encoding: 'utf8' }).trim(),
    ${JSON.stringify(annotatedTagObject)}, 'the annotated tag ref keeps its original object identity');
  assert.equal(execFileSync('git', ['rev-parse', 'refs/tags/runner-lightweight'], { encoding: 'utf8' }).trim(),
    ${JSON.stringify(lightweightTagObject)}, 'the lightweight tag ref points to its original commit');
  const batchTagObjects = ${JSON.stringify(batchTagObjects)};
  const actualTagObjects = new Map(execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags'],
    { encoding: 'utf8' }).trim().split('\\n').map(line => line.split(' ')));
  for (const [name, object] of batchTagObjects) assert.equal(actualTagObjects.get(name), object, 'every delivered tag keeps its exact object across fetch batches');
  if (batchTagObjects.length) {
    const peeled = execFileSync('git', ['rev-parse', '--revs-only', '--end-of-options', ...batchTagObjects.map(([name]) => name + '^{}')], { encoding: 'utf8' }).trim().split('\\n');
    assert.deepEqual(peeled, batchTagObjects.map(() => ${JSON.stringify(historyBaseCommit)}), 'nested annotations and lightweight aliases all peel to their exact candidate ancestor');
  }
  const annotation = execFileSync('git', ['cat-file', '-p', 'refs/tags/runner-release'], { encoding: 'utf8' });
  assert.match(annotation, /runner release annotation witness/u);
  const annotatedArchive = execFileSync('git', ['archive', '--format=tar', 'refs/tags/runner-release', 'history-original.txt']);
  const lightweightArchive = execFileSync('git', ['archive', '--format=tar', 'refs/tags/runner-lightweight', 'history-original.txt']);
  assert.ok(annotatedArchive.length > 512 && annotatedArchive.includes(Buffer.from('history-original.txt')),
    'the annotated archive can read the tagged historical file');
  assert.ok(lightweightArchive.length > 512 && lightweightArchive.includes(Buffer.from('history-original.txt')),
    'the lightweight archive can read the tagged historical file');
  assert.deepEqual(execFileSync('git', ['tag', '--list', 'runner-unrelated'], { encoding: 'utf8' }).trim(), '',
    'a tag outside candidate ancestry is not copied');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '');
  assert.equal(existsSync('.env'), false, 'ignored, untracked caller files are not transferred');
  assert.equal(process.env.PULLBOARD_RUNNER_FIXTURE_SECRET, undefined);
  assert.equal(process.env.PULLBOARD_GATE_SLOT_HELD, '1');
  assert.ok(process.env.PULLBOARD_GATE_SLOT_POOL.endsWith('/resources.sqlite'));
  assert.notEqual(process.env.PULLBOARD_GATE_SLOT_POOL, ${JSON.stringify(callerPool)});
  assert.ok(process.env.PULLBOARD_GATE_SLOT_TOKEN);
  assert.notEqual(process.env.PULLBOARD_GATE_SLOT_TOKEN, ${JSON.stringify(callerToken)});
  assert.equal(process.env.PULLBOARD_BROWSER_SLOT_HELD, '1');
  const db = new DatabaseSync(process.env.PULLBOARD_GATE_SLOT_POOL, { readOnly: true });
  try {
    const holder = db.prepare('SELECT pid, browser, kind FROM holder WHERE token = ?').get(process.env.PULLBOARD_GATE_SLOT_TOKEN);
    assert.ok(holder, 'the child inherited a live remote parent lease');
    assert.notEqual(holder.pid, process.pid);
    assert.equal(holder.browser, 1);
    assert.equal(holder.kind, 'check');
  } finally { db.close(); }
  assert.equal(process.env.SSH_AUTH_SOCK, undefined);
  assert.notEqual(process.env.PULLBOARD_HOME, ${JSON.stringify(sourceHome)});
  assert.notEqual(process.env.PULLBOARD_MACHINE_HOME, ${JSON.stringify(sourceMachineHome)});
  console.log('RUNNER_FACT ' + JSON.stringify({ commit, tree, cwd: process.cwd(), home: process.env.HOME,
    runnerHome, stateRoot: ${JSON.stringify(remoteStateRoot)}, machineHome: process.env.PULLBOARD_MACHINE_HOME, gatePool: process.env.PULLBOARD_GATE_SLOT_POOL,
    gateToken: process.env.PULLBOARD_GATE_SLOT_TOKEN, browser: process.env.PULLBOARD_BROWSER_SLOT_HELD,
    landing: process.env.PULLBOARD_LANDING_RUN }));
});
`;
  writeFileSync(join(repo, 'runner-probe.test.js'), probe);
}

/** Build a committed probe for the cache copy of one local workspace dependency. */
export function writeCacheProbe(repo, { remoteStateRoot, nodePath, historyBaseCommit }) {
  const probe = `import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { test } from 'node:test';
test('a cached workspace link resolves inside this fresh runner checkout', () => {
  const root = process.cwd();
  const stateRelative = relative(${JSON.stringify(remoteStateRoot)}, root);
  assert.ok(stateRelative && !stateRelative.startsWith('..' + sep) && stateRelative !== '..');
  assert.equal(process.execPath, ${JSON.stringify(nodePath)}, 'the configured runner Node executes the command');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  const generated = JSON.parse(readFileSync(join(root, 'generated/config.json'), 'utf8'));
  assert.equal(generated.root, root, 'root prepare ran in this fresh checkout and generated a job-local file');
  const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim();
  const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
  const history = execFileSync('git', ['log', '--follow', '--format=%H', '--', 'history-renamed.txt'], { encoding: 'utf8' }).trim().split(/\\r?\\n/u);
  assert.equal(shallow, 'false', 'the cache contains full candidate history');
  assert.equal(count, '3', 'the cache preserves the complete selected history');
  assert.ok(history.includes(${JSON.stringify(historyBaseCommit)}), 'cached history follows the original filename through the rename');
  const committed = execFileSync('git', ['show', 'HEAD:packages/runner-fixture-dep/witness.txt'], { encoding: 'utf8' });
  assert.equal(readFileSync('node_modules/.runner-cache-witness', 'utf8'), committed);
  const link = readlinkSync('node_modules/runner-fixture-dep');
  assert.equal(isAbsolute(link), false, 'the cached workspace symlink stays relative');
  const target = realpathSync(join(root, 'node_modules/runner-fixture-dep'));
  assert.equal(target, join(root, 'packages/runner-fixture-dep'));
  const targetRelative = relative(root, target);
  assert.ok(targetRelative && !targetRelative.startsWith('..' + sep) && targetRelative !== '..');
  console.log('RUNNER_CACHE_FACT ' + JSON.stringify({ root, link, target, commit, tree, shallow, count, history, generatedRoot: generated.root }));
});
`;
  writeFileSync(join(repo, 'runner-cache-probe.test.js'), probe);
}
