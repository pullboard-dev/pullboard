/** Runner jobs started together for one new commit share one history scan through protectHistory [C7]. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const RUNNERS = pathToFileURL(resolve(import.meta.dirname, '../packages/runners/index.js')).href;
const CONFIG = pathToFileURL(resolve(import.meta.dirname, '../packages/config/index.js')).href;
/** One runner job's history check, run in its own process exactly as each runner controller runs it. */
const JOB = `import { protectHistory } from ${JSON.stringify(RUNNERS)};
import { defaults } from ${JSON.stringify(CONFIG)};
try { protectHistory(process.env.HISTORY_ROOT, { commit: process.env.HISTORY_COMMIT }, [defaults().protect]); console.log('clean'); }
catch (error) { console.log(error.code ?? error.message); }`;

/**
 * A fresh repository, a private machine home, and a git shim that logs each history `git log` and holds it two seconds,
 * so every job starts while the first scan is still running.
 */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-history-flight-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo'), shims = join(dir, 'bin'), launches = join(dir, 'git-log-launches');
  mkdirSync(shims);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(shims, 'git'), [
    '#!/bin/sh',
    'for arg in "$@"; do if [ "$arg" = log ]; then echo log >> "$HISTORY_LAUNCHES"; sleep 2; break; fi; done',
    'exec "$REAL_GIT" "$@"',
  ].join('\n') + '\n');
  chmodSync(join(shims, 'git'), 0o755);
  execFileSync(realGit, ['init', '-q', '-b', 'main', root]);
  const add = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
    execFileSync(realGit, ['add', path], { cwd: root });
    execFileSync(realGit, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', path], { cwd: root });
    return execFileSync(realGit, ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  };
  const env = { ...process.env, PATH: `${shims}:${process.env.PATH}`, REAL_GIT: realGit, HISTORY_LAUNCHES: launches,
    HISTORY_ROOT: root, PULLBOARD_MACHINE_HOME: join(dir, 'machine-home') };
  /** Start `count` jobs at once for `commit` and collect each one's answer. */
  const jobs = (count, commit) => Promise.all(Array.from({ length: count }, () => new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', JOB], { env: { ...env, HISTORY_COMMIT: commit } });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', fail);
    child.on('close', code => code === 0 ? done(out.trim()) : fail(new Error(`job exited ${code}: ${err}`)));
  })));
  const scans = () => existsSync(launches) ? readFileSync(launches, 'utf8').split('\n').filter(Boolean).length : 0;
  return { add, jobs, scans };
}

test('clause 1: four runner jobs started together for one new commit run exactly one history git log through protectHistory and all pass from its cached answer [C7]', async t => {
  const { add, jobs, scans } = fixture(t);
  add('src/first.txt', 'one\n');
  const head = add('src/second.txt', 'two\n');
  assert.deepEqual(await jobs(4, head), ['clean', 'clean', 'clean', 'clean'], 'every job passes the protection check');
  assert.equal(scans(), 1, 'one history scan ran between the four concurrent jobs');
});

test('clause 2: a blocked private path in history is still refused RUNNER_SECRET for every waiting caller [C7]', async t => {
  const { add, jobs, scans } = fixture(t);
  add('data/board.sqlite', 'private\n');
  const head = add('src/later.txt', 'later\n');
  assert.deepEqual(await jobs(4, head), ['RUNNER_SECRET', 'RUNNER_SECRET', 'RUNNER_SECRET', 'RUNNER_SECRET'], 'every caller is refused');
  assert.equal(scans(), 1, 'the waiting callers refuse from the first scan without reading history again');
});
