/** `pullboard lane add` declares a lane, and init proposes lanes from the folder layout [I1,I2,L1]. */
import assert from 'node:assert/strict';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/** A private repository with the given folders, each holding one file, and pullboard at hand. */
function project(t, folders) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-lane-add-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PULLBOARD_HOME: join(root, '.private-home') };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(key)) delete env[key];
  for (const folder of folders) {
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, 'index.js'), 'export {};\n');
  }
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
  /** Run pullboard in-process in this repository and keep its output as a person would see it. */
  const runLocal = (...args) => runCliInProcess(args, { cwd: root, env });
  /** The lanes pullboard.json declares right now. */
  const lanes = () => JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8')).lanes;
  return { root, runLocal, lanes };
}

test('lane add creates a lane and init proposes lanes from the layout [I1,I2,L1]', async (t) => {
  // init proposes one lane per top-level package for a packages/* layout, and writes none of them.
  const box = project(t, ['packages/web/src', 'packages/api', 'docs']);
  const init = await box.runLocal('init', '--verbose');
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /^proposed lanes: api owns packages\/api\/; web owns packages\/web\/$/mu);
  assert.match(init.stdout, /^add them from the main checkout, then tell the person which lanes you made: pullboard lane add api --owns packages\/api\/ && pullboard lane add web --owns packages\/web\/$/mu);
  assert.deepEqual(Object.keys(box.lanes()), ['review'], 'init itself writes no proposed lane; the agent adds it with the printed command');
  const rerun = await box.runLocal('init', '--json');
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.deepEqual(JSON.parse(rerun.stdout).proposedLanes, [
    { name: 'api', owns: ['packages/api/'] },
    { name: 'web', owns: ['packages/web/'] },
  ]);

  // lane add writes the lane to pullboard.json, keeping every other setting, and lanes lists it.
  const before = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  const added = await box.runLocal('lane', 'add', 'web', '--owns', 'packages/web');
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /^added lane web: owns packages\/web\/$/mu);
  const both = await box.runLocal('lane', 'add', 'api', '--owns', 'packages/api/,docs/');
  assert.equal(both.status, 0, both.stderr);
  const after = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  assert.deepEqual(after, { ...before, lanes: { ...before.lanes, web: { owns: ['packages/web/'] }, api: { owns: ['packages/api/', 'docs/'] } } });
  const listed = await box.runLocal('lanes');
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^web\s+packages\/web\/$/mu);
  assert.match(listed.stdout, /^api\s+packages\/api\/ docs\/$/mu);

  // An owned path, exact or inside another lane's folder, is refused and names its owner.
  const config = readFileSync(join(box.root, 'pullboard.json'), 'utf8');
  const owned = await box.runLocal('lane', 'add', 'site', '--owns', 'packages/web/');
  assert.equal(owned.status, 1);
  assert.match(owned.stderr, /\[PATH_OWNED\] packages\/web\/ is already owned by lane "web"/u);
  const nested = await box.runLocal('lane', 'add', 'ui', '--owns', 'packages/web/src');
  assert.equal(nested.status, 1);
  assert.match(nested.stderr, /\[PATH_OWNED\] packages\/web\/src\/ is already owned by lane "web"/u);
  assert.match(nested.stderr, /carving a sub-folder out of web is a hand edit of "lanes" in pullboard\.json/u);
  // A taken name is refused and names the lane that has it.
  const taken = await box.runLocal('lane', 'add', 'web', '--owns', 'site/');
  assert.equal(taken.status, 1);
  assert.match(taken.stderr, /\[LANE_TAKEN\] lane "web" already exists and owns packages\/web\//u);
  const coordinator = await box.runLocal('lane', 'add', 'coordinator', '--owns', 'site/');
  assert.equal(coordinator.status, 1);
  assert.match(coordinator.stderr, /\[LANE_TAKEN\] "coordinator" belongs to the coordinator/u);
  assert.equal(readFileSync(join(box.root, 'pullboard.json'), 'utf8'), config, 'a refusal leaves pullboard.json as it was');

  // Once a lane owns a folder, init proposes nothing more.
  const settled = await box.runLocal('init', '--json');
  assert.equal(settled.status, 0, settled.stderr);
  assert.deepEqual(JSON.parse(settled.stdout).proposedLanes, []);

  // An apps/* layout gets one lane per app.
  const apps = project(t, ['apps/mobile', 'apps/site']);
  const appsInit = await apps.runLocal('init', '--verbose');
  assert.equal(appsInit.status, 0, appsInit.stderr);
  assert.match(appsInit.stdout, /^proposed lanes: mobile owns apps\/mobile\/; site owns apps\/site\/$/mu);
  assert.deepEqual(Object.keys(apps.lanes()), ['review']);

  // Any other layout gets one app lane.
  const plain = project(t, ['src', 'test']);
  const plainInit = await plain.runLocal('init', '--verbose');
  assert.equal(plainInit.status, 0, plainInit.stderr);
  assert.match(plainInit.stdout, /^proposed lanes: app owns src\/ test\/$/mu);
  assert.match(plainInit.stdout, /^add them from the main checkout, then tell the person which lanes you made: pullboard lane add app --owns src\/,test\/$/mu);
  assert.deepEqual(Object.keys(plain.lanes()), ['review']);
  const accepted = await plain.runLocal('lane', 'add', 'app', '--owns', 'src/,test/');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(plain.lanes().app, { owns: ['src/', 'test/'] });
});

test('init lets the agent add the first lane and tell the person, never stop to ask [I1,I2,L1]', async (t) => {
  const box = project(t, ['server', 'test']);
  const init = await box.runLocal('init', '--verbose');
  assert.equal(init.status, 0, init.stderr);
  const lanes = init.stdout.split('\n').filter((line) => /lane/u.test(line));
  assert.ok(lanes.some((line) => /^add them from the main checkout, then tell the person which lanes you made: pullboard lane add app --owns server\/,test\/$/u.test(line)), lanes.join('\n'));
  assert.equal(lanes.some((line) => /ask the person|until the person accepts|to accept, run/u.test(line)), false, 'no line tells the agent to wait for the person before the first lane');
  const agents = readFileSync(join(box.root, 'AGENTS.md'), 'utf8');
  assert.match(readFileSync(join(box.root, 'CLAUDE.md'), 'utf8'), /AGENTS\.md/u, 'CLAUDE.md sends the agent to AGENTS.md');
  assert.doesNotMatch(agents, /once the person agrees|writes none until the person accepts/u, 'the written instructions agree with what init printed');
  assert.match(agents, /adds those first lanes without waiting, then tells the person which lanes it made/u);
  assert.match(agents, /a change to which lane owns a path waits for the person's OK/u, 'later ownership changes stay the person\'s');
  const added = await box.runLocal('lane', 'add', 'app', '--owns', 'server/,test/');
  assert.equal(added.status, 0, 'the agent in the main checkout can run the printed command itself: ' + added.stderr);
  assert.deepEqual(box.lanes().app.owns, ['server/', 'test/']);
});
