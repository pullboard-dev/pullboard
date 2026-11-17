/** @pullboard-test-input source-cell apps/cli apps/lib packages/items packages/pages packages/roadmap packages/runners packages/seats packages/store */
/** Unmerged source protects both shared formats, including indirect openers and real hooks [A5,A6]. */
import { copyPackageFiles } from '../index.js';
import { packageFiles } from '../index.js';
import { toolSourcePath } from '../index.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  relative,
  resolve,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

/** The built project, made once per file; every case gets a private copy [C7,#8131]. */
let template = null;

/** A private empty directory; every one has the same path length, which the retargeting relies on. */
function sandbox() { return realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-shared-version-'))); }

/** Copy the built project to a new path: one copy-on-write clone where the volume has them, whose cost does not grow with the file count; a plain recursive copy otherwise. */
function cloneTree(from, to) {
  rmdirSync(to); // The sandbox's empty directory: cp creates the destination itself.
  for (const flags of process.platform === 'darwin' ? [['-cRp'], ['-Rp']] : [['-Rp']]) {
    if (spawnSync('cp', [...flags, from, to], { stdio: 'ignore' }).status === 0) return;
    rmSync(to, { recursive: true, force: true });
  }
  cpSync(from, to, { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true });
}

/** Where a sandbox's own path is stored: Git metadata, editor settings and the private homes; source files and Git objects never hold it. */
const STATE = ['repo/.git', 'lane/.git', 'repo/.claude', 'lane/.claude', 'board-home', 'machine-home', 'home', 'executables'];

/** Replace one sandbox path with another of the same length in a file, or in every file under a directory but compressed git objects. */
function retarget(path, from, to) {
  let stat; try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) if (!(name === 'objects' && path.endsWith('/.git'))) retarget(join(path, name), from, to);
    return;
  }
  if (!stat.isFile()) return;
  const data = readFileSync(path); const needle = Buffer.from(from); const next = Buffer.from(to);
  let at = data.indexOf(needle); if (at < 0) return;
  for (; at >= 0; at = data.indexOf(needle, at + needle.length)) next.copy(data, at);
  writeFileSync(path, data);
}

/** Build the project the ordinary way, once: the actual candidate as a primary and a joined linked source checkout. */
function buildTemplate() {
  const dir = sandbox();
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo'); const lane = join(dir, 'lane');
  const executables = join(dir, 'executables'); mkdirSync(executables);
  writeFileSync(join(executables, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "$(git rev-parse --show-toplevel)/apps/cli/pullboard.js" "$@"\n`);
  chmodSync(join(executables, 'pullboard'), 0o755);
  mkdirSync(root);
  const source = resolve(import.meta.dirname, '../../..'); // The docs, archived board history and the project's own tests (over 40% of its files) are never read here; init reads the view app and skills.
  copyPackageFiles(source, root, { files: packageFiles(source).filter(file => !/^(?:docs|packages\/state\/data|test|packages\/[^/]+\/tests|apps\/[^/]+\/(?:tests|journeys))\//u.test(file)) });
  const env = environment(dir);
  const run = (cwd, program, args) => spawnSync(program, args, { cwd, env, encoding: 'utf8' });
  const git = (cwd, ...args) => { const r = run(cwd, 'git', args); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout.trim(); };
  const cli = (code, cwd, ...args) => run(cwd, process.execPath, [join(code, 'apps/cli/pullboard.js'), ...args]);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', lanes: { core: { owns: ['src/', 'packages/store/src/io/board/schema/source.js'] } } }));
  writeFileSync(join(root, 'SPEC.md'), '# Version fixture\n\n## G · Goals\n- G1 [approved, must] Preserve the shared board. | gate: true\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'chore: initialize source fixture');
  const initialized = cli(root, root, 'init'); assert.equal(initialized.status, 0, initialized.stderr);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'chore: install source fixture hooks');
  git(root, 'worktree', 'add', '-q', '-b', 'core/future', lane, 'main');
  const joined = cli(root, lane, 'join', 'core', '--route', 'strong', '--json'); assert.equal(joined.status, 0, joined.stderr + joined.stdout);
  git(root, 'gc', '-q', '--prune=now'); // One pack file instead of thousands of loose objects: every case copies this tree.
  return dir;
}

/** The private environment of one sandbox directory. */
function environment(dir) {
  const env = { ...process.env, HOME: join(dir, 'home'), PULLBOARD_HOME: join(dir, 'board-home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), PATH: join(dir, 'executables') + ':' + process.env.PATH };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  delete env.PULLBOARD_RELAY_TOKEN;
  return Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Version Fixture', GIT_AUTHOR_EMAIL: 'version@example.test', GIT_COMMITTER_NAME: 'Version Fixture', GIT_COMMITTER_EMAIL: 'version@example.test' });
}

/** A private copy of the built project: the actual candidate as an isolated primary and linked source checkout. */
function fixture(t) {
  template ??= buildTemplate();
  const dir = sandbox();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cloneTree(template, dir);
  for (const state of STATE) retarget(join(dir, state), template, dir);
  const root = join(dir, 'repo'); const lane = join(dir, 'lane');
  const env = environment(dir);
  /** Execute a fixture command and retain its real status and diagnostic. */
  const run = (cwd, program, args) => spawnSync(program, args, { cwd, env, encoding: 'utf8' });
  /** Require a real Git operation to succeed without bypassing hooks. */
  const git = (cwd, ...args) => { const r = run(cwd, 'git', args); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout.trim(); };
  /** Run source from the chosen checkout, independently of the command's working directory. */
  const cli = (code, cwd, ...args) => run(cwd, process.execPath, [join(code, 'apps/cli/pullboard.js'), ...args]);
  const file = join(root, '.git/pullboard/board.sqlite');
  /** Run a source-level probe in a fresh process, always under the private fixture environment. */
  const probe = (source) => { const path = join(lane, 'probe.mjs'); writeFileSync(path, source); const r = run(lane, process.execPath, [path]); assert.equal(r.status, 0, r.stderr + r.stdout); return JSON.parse(r.stdout); };
  /** Read persistent formats without invoking a writable opener. */
  const versions = () => { const db = new DatabaseSync(file, { readOnly: true }); try { return { schema: db.prepare('PRAGMA user_version').get().user_version, log: db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='event_log_version'").get().meta_value }; } finally { db.close(); } };
  /** Change only one version constant in the uncommitted linked source. */
  const bump = (name, from, to) => { const path = toolSourcePath(lane, 'packages/store/src/io/board/schema/source.js'); const text = readFileSync(path, 'utf8'); const updated = text.replace(`export const ${name} = ${from};`, `export const ${name} = ${to};`); assert.notEqual(updated, text); writeFileSync(path, updated); return relative(lane, path); };
  return { dir, root, lane, env, file, run, cli, git, probe, versions, bump };
}

test('runners.version.an-event-log-only-worktree-refuses: clause 1: an event-log-only worktree refuses upgrades and primary source still opens [A5,A6]', t => {
  const box = fixture(t); const before = box.versions(); box.bump('EVENT_LOG_VERSION', 1, 2);
  const r = box.cli(box.lane, box.root, 'status', '--json');
  assert.equal(r.status, 1, r.stderr + r.stdout); const error = JSON.parse(r.stdout).error;
  assert.equal(error.code, 'UNMERGED_SCHEMA'); assert.match(error.message, /event log 2.*version 1/);
  assert.deepEqual(box.versions(), before);
  const doctor = box.cli(box.lane, box.lane, 'doctor', '--json');
  assert.equal(doctor.status, 1, doctor.stderr + doctor.stdout);
  const finding = JSON.parse(doctor.stdout).problems.find(p => p.code === 'EVENT_LOG_VERSION');
  assert.ok(finding); assert.match(finding.next, /merge.*main checkout.*status there/);
  assert.deepEqual(box.versions(), before);
  const primary = box.cli(box.root, box.lane, 'status', '--json'); assert.equal(primary.status, 0, primary.stderr + primary.stdout);
  assert.deepEqual(box.versions(), before);
});

test('runners.version.a-broken-git-link-cannot-impersonate: clause 1: a broken Git link cannot impersonate an installed release and upgrade a board [A5,A6]', t => {
  const box = fixture(t); const before = box.versions(); box.bump('SCHEMA_VERSION', 3, 4);
  const broken = join(box.dir, 'broken'); mkdirSync(broken);
  cloneTree(box.lane, broken); // The newer source with its Git link replaced below.
  writeFileSync(join(broken, '.git'), 'gitdir: /nonexistent/pullboard-pruned-link\n');
  const r = box.cli(broken, box.root, 'status', '--json'); assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.equal(JSON.parse(r.stdout).error.code, 'UNMERGED_SCHEMA'); assert.match(JSON.parse(r.stdout).error.next, /restore its Git link/);
  assert.deepEqual(box.versions(), before);
});

test('runners.version.a-newer-lane-can-make-a: clause 1: a newer lane can make a real checked commit and doctor gives a working main-checkout step [A5,A6]', t => {
  const box = fixture(t); const before = box.versions(); const versionSource = box.bump('SCHEMA_VERSION', 3, 4);
  writeFileSync(join(box.lane, '.githooks/pre-commit'), `#!/bin/sh\nexec "${process.execPath}" "$(git rev-parse --show-toplevel)/apps/cli/pullboard.js" hook pre-commit\n`);
  box.git(box.lane, 'add', versionSource); box.git(box.lane, 'commit', '-q', '-m', 'feat: propose a future schema [G1]');
  assert.deepEqual(box.versions(), before, 'the actual checkout hook must not migrate the shared board');
  const r = box.cli(box.lane, box.lane, 'doctor', '--json'); assert.equal(r.status, 1, r.stderr + r.stdout);
  const finding = JSON.parse(r.stdout).problems.find(p => p.code === 'SCHEMA_VERSION');
  assert.ok(finding); assert.match(finding.next, /merge.*main checkout.*status there/);
  assert.doesNotMatch(finding.next, /^run pullboard status/); assert.deepEqual(box.versions(), before);
});

test('runners.version.relay-snapshot-guards-its-native-board: clause 1: relay snapshot guards its native board open even when presentation is already supplied [A5,A6]', t => {
  const box = fixture(t); const before = box.versions(); box.bump('EVENT_LOG_VERSION', 1, 2);
  const relay = toolSourcePath(box.lane, 'packages/pages/src/io/relay/presentation.js');
  const original = readFileSync(relay, 'utf8');
  const supplied = original.replace(/^export function relayPresentation\([^\n]+\) \{[\s\S]*?^\}/mu,
    'export function relayPresentation() { return {version:1,state:{events:[]}}; }');
  assert.notEqual(supplied, original, 'supply presentation without replacing the actual snapshot opener');
  writeFileSync(relay, supplied);
  const result = box.probe(`import { nativeBoardPorts } from './apps/lib/index.js'; import { relaySnapshot } from './packages/pages/index.js'; try { relaySnapshot(${JSON.stringify(box.root)}, {}, nativeBoardPorts().presentation); console.log(JSON.stringify({code:'OPENED'})); } catch(e) { console.log(JSON.stringify({code:e.code})); }`);
  assert.equal(result.code, 'UNMERGED_SCHEMA'); assert.deepEqual(box.versions(), before);
});

test('runners.version.relay-presentation-refuses-before-asking-the: clause 1: relay presentation refuses before asking the view projection to open a newer board [A5,A6]', t => {
  const box = fixture(t); const before = box.versions(); box.bump('EVENT_LOG_VERSION', 1, 2);
  const result = box.probe(`import { nativeBoardPorts } from './apps/lib/index.js'; import { relayPresentation } from './packages/pages/index.js'; try { relayPresentation(${JSON.stringify(box.root)}, {}, nativeBoardPorts().presentation); console.log(JSON.stringify({code:'OPENED'})); } catch(e) { console.log(JSON.stringify({code:e.code})); }`);
  assert.equal(result.code, 'UNMERGED_SCHEMA'); assert.deepEqual(box.versions(), before);
});

test('runners.version.a-roadmap-external-board-open-refuses: clause 1: a roadmap external-board open refuses unmerged event-log source [A5,A6]', t => {
  const box = fixture(t); const before = box.versions(); box.bump('EVENT_LOG_VERSION', 1, 2);
  const result = box.probe(`
    import { closeBoard } from './packages/store/index.js';
    import { openBoard } from './apps/lib/index.js';
    import { addMilestone, roadmap } from './packages/store/index.js';
    import * as store from './packages/store/index.js';
    import { registerProject } from './packages/seats/index.js';
    import { listApiProjects } from './packages/seats/index.js';
    import { milestoneRoadmap } from './packages/roadmap/index.js';
    import { workQueue } from './packages/items/index.js';
    registerProject(${JSON.stringify(box.root)}, new Date(), {name:'external'});
    const board = openBoard(':memory:');
    addMilestone(board, {agentId:'coordinator',name:'External',items:['repo#1']});
    try { console.log(JSON.stringify(milestoneRoadmap(${JSON.stringify(box.lane)}, board, { ports: { ...store, roadmap, openBoard, workQueue, listApiProjects } }))); } finally {closeBoard(board);}
  `);
  assert.equal(result[0].items[0].status, 'unavailable'); assert.deepEqual(box.versions(), before);
});


test('runners.version.a-held-item-remains-readable-by: clause 1: a held item remains readable by newer-source read-only spec citations [A5,A6,S8,S10]', t => {
  const box = fixture(t);
  const added = box.cli(box.root, box.root, 'add', 'core', 'Preserve held citations', '--specs', 'G1');
  assert.equal(added.status, 0, added.stderr + added.stdout);
  const claimed = box.cli(box.root, box.lane, 'claim', '1');
  assert.equal(claimed.status, 0, claimed.stderr + claimed.stdout);
  const before = readFileSync(box.file);
  box.bump('SCHEMA_VERSION', 3, 4);
  const checked = box.cli(box.lane, box.lane, 'spec', 'check', '--json');
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
  assert.deepEqual(readFileSync(box.file), before, 'spec citations read a live claim without migrating or writing its board');
});
