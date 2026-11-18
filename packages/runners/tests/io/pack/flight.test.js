/** Runner jobs started together for one new commit share one history scan through protectHistory [C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import { cellProject } from '../../../../store/tests/fixtures/cell.js';

const cleanups = [];
after(() => { for (const cleanup of cleanups.reverse()) cleanup(); });
/** The module-level owner of each cell project's cleanup, for helpers that run outside a test context. */
const owner = { after: cleanup => cleanups.push(cleanup) };

const RUNNERS = pathToFileURL(resolve(import.meta.dirname, '../../../index.js')).href;
const CONFIG = pathToFileURL(resolve(import.meta.dirname, '../../../../config/index.js')).href;
/** One runner job's history check, run in its own process exactly as each runner controller runs it. */
const JOB = `import { protectHistory } from ${JSON.stringify(RUNNERS)};
import { defaults } from ${JSON.stringify(CONFIG)};
try { protectHistory(process.env.HISTORY_ROOT, { commit: process.env.HISTORY_COMMIT }, [defaults().protect]); console.log('clean'); }
catch (error) { console.log(error.code ?? error.message); }`;

/**
 * A kit repository with its own private machine home, and a git shim that logs each history `git log` and holds it two
 * seconds, so every job starts while the first scan is still running.
 */
function fixture() {
  const box = cellProject(owner, { real: true, gate: 'true' });
  const shims = join(box.dir, 'history-shims'), launches = join(box.dir, 'git-log-launches');
  mkdirSync(shims);
  writeFileSync(join(shims, 'git'), [
    '#!/bin/sh',
    'for arg in "$@"; do if [ "$arg" = log ]; then echo log >> "$HISTORY_LAUNCHES"; sleep 2; break; fi; done',
    'PATH="$REAL_PATH" exec git "$@"',
  ].join('\n') + '\n');
  chmodSync(join(shims, 'git'), 0o755);
  const add = (path, body) => {
    mkdirSync(dirname(join(box.repo, path)), { recursive: true });
    writeFileSync(join(box.repo, path), body);
    box.git(box.repo, 'add', '-f', path);
    // The fixture history itself may hold a blocked path, so its commits skip the project's own hooks.
    box.git(box.repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', path);
    return box.git(box.repo, 'rev-parse', 'HEAD').trim();
  };
  const env = { ...box.env, PATH: `${shims}:${box.env.PATH}`, REAL_PATH: box.env.PATH, HISTORY_LAUNCHES: launches, HISTORY_ROOT: box.repo };
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

test('runners.flight.four-runner-jobs-started-together-for: clause 1: four runner jobs started together for one new commit run exactly one history git log through protectHistory and all pass from its cached answer [C7]', async () => {
  const { add, jobs, scans } = fixture();
  add('src/first.txt', 'one\n');
  const head = add('src/second.txt', 'two\n');
  assert.deepEqual(await jobs(4, head), ['clean', 'clean', 'clean', 'clean'], 'every job passes the protection check');
  assert.equal(scans(), 1, 'one history scan ran between the four concurrent jobs');
});

test('runners.flight.a-blocked-private-path-in-history: clause 2: a blocked private path in history is still refused RUNNER_SECRET for every waiting caller [C7]', async () => {
  const { add, jobs, scans } = fixture();
  add('data/board.sqlite', 'private\n');
  const head = add('src/later.txt', 'later\n');
  assert.deepEqual(await jobs(4, head), ['RUNNER_SECRET', 'RUNNER_SECRET', 'RUNNER_SECRET', 'RUNNER_SECRET'], 'every caller is refused');
  assert.equal(scans(), 1, 'the waiting callers refuse from the first scan without reading history again');
});
