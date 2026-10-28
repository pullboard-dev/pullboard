/** @pullboard-module-loads bin/pullboard.js */
/** Concurrent real submits share completed main evidence without serializing their test runs [V4,C7]. */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runFixtureChild, runFixtureGit, startFixtureChild } from './fixture-child.js';

const BIN = join(import.meta.dirname, '../bin/pullboard.js');

/** Write only one private fixture's source or synchronization file. */
function put(root, file, source) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source); }
/** Preserve real CLI output and fail setup at its actual refusal. */
function cli(box, root, ...args) {
  const run = runFixtureChild(process.execPath, [BIN, ...args, '--json'], { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(run.status, 0, (run.context ?? '') + '\n' + run.stdout + run.stderr);
  return JSON.parse(run.stdout);
}
/** Commit genuine fixture source with isolated identity. */
function commit(box, root) {
  runFixtureGit(['add', '-A'], { cwd: root, env: box.env });
  runFixtureGit(['commit', '-qm', 'test: independent fixture change'], { cwd: root, env: box.env });
  return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root, env: box.env }).trim();
}
/** Read the actual immutable submission event, without modifying or keeping the board open. */
function receipt(box, id) {
  const db = new DatabaseSync(join(box.root, '.git/pullboard/board.sqlite'), { readOnly: true });
  try {
    const row = db.prepare("SELECT event_id,event_detail FROM event WHERE event_kind='submit' AND item_id=? ORDER BY event_id DESC LIMIT 1").get(id);
    return row && { sequence: row.event_id, detail: JSON.parse(row.event_detail) };
  } finally { db.close(); }
}
/** Wait on an external handshake; this ceiling detects hangs rather than asserting machine speed. */
async function observed(predicate, message) {
  const deadline = Date.now() + 120_000; // budget: real private CLI/admission handshake, not a speed target.
  while (!predicate() && Date.now() < deadline) await pause(20);
  assert.ok(predicate(), message);
}

/** Build two independent claimed items sharing a real red main and one open repair. */
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pb-cache-submit-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo'); mkdirSync(root);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  delete env.NODE_TEST_CONTEXT; delete env.PULLBOARD_RELAY_TOKEN;
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Cache Fixture', GIT_AUTHOR_EMAIL: 'cache@example.invalid', GIT_COMMITTER_NAME: 'Cache Fixture', GIT_COMMITTER_EMAIL: 'cache@example.invalid', PULLBOARD_HOME: join(directory, 'home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine'), PULLBOARD_MODEL: 'Fixture Model', CACHE_CONTROL: join(directory, 'control') });
  mkdirSync(env.CACHE_CONTROL);
  const box = { directory, root, env };
  const word = value => "'" + value.replaceAll("'", "'\\''") + "'";
  put(directory, 'bin/pullboard', `#!/bin/sh\nexec ${word(process.execPath)} ${word(BIN)} "$@"\n`);
  chmodSync(join(directory, 'bin/pullboard'), 0o755);
  env.PATH = join(directory, 'bin') + ':' + process.env.PATH;
  put(directory, 'machine/settings.json', JSON.stringify({ gateSlots: 4, browserSlots: 1, gate: { browserFreeChecks: true } }));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  cli(box, root, 'init');
  put(root, 'package.json', '{"type":"module"}\n');
  put(root, 'pullboard.json', JSON.stringify({ gate: 'node test/runner.js', affectedTests: 'node test/runner.js', lanes: { core: { owns: ['changes/', 'test/'], specs: ['G'] } } }));
  put(root, 'SPEC.md', '# Fixture\n\n## G · Goals\n- G1 [approved, must] Configured checks describe this fixture. | gate: test/runner.js\n');
  for (const name of ['a', 'b']) put(root, `test/${name}.test.js`, `import assert from 'node:assert/strict';import {test} from 'node:test';test('${name} actual inherited assertion [G1]',()=>assert.equal(1,2));\n`);
  put(root, 'test/runner.js', [
    "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
    "import { basename, dirname, join } from 'node:path';",
    "import { setTimeout as pause } from 'node:timers/promises';",
    "import { spawnSync } from 'node:child_process';",
    "const files = process.argv.slice(2).length ? process.argv.slice(2).map(file=>file.replace(/^\\.\\//,'')) : process.env.CACHE_CASE==='second' ? ['test/b.test.js'] : ['test/a.test.js','test/b.test.js'];",
    "const comparison = basename(process.cwd())==='checkout' && basename(dirname(process.cwd())).startsWith('pullboard-main-red-');",
    "if(comparison){appendFileSync(join(process.env.CACHE_CONTROL,'runs.jsonl'),JSON.stringify({mode:process.env.CACHE_CASE,files})+'\\n');",
    "if(process.env.CACHE_CASE==='first' && files.includes('test/a.test.js')){writeFileSync(join(process.env.CACHE_CONTROL,'first.ready'),'ready');while(!existsSync(join(process.env.CACHE_CONTROL,'first.release')))await pause(10);}}",
    "const child=spawnSync(process.execPath,['--test','--test-reporter=tap',...files],{encoding:'utf8',env:process.env});process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');process.exitCode=child.status??1;",
  ].join('\n'));
  box.main = commit(box, root);
  const ids = ['a', 'b'].map(name => cli(box, root, 'add', 'core', 'Independent ' + name, '--specs', 'G1', '--route', 'mid', '--criterion', 'The independent file exists.', '--check', `test -f changes/${name}.txt`, '--brief', `Files: changes/${name}.txt\nTest: independent file`).item.item_id);
  box.builders = ids.map((id, index) => {
    const made = cli(box, root, 'worktree', 'core', '--route', 'mid', '--model', 'Fixture Model');
    cli(box, made.path, 'claim', String(id));
    put(made.path, `changes/${['a','b'][index]}.txt`, 'independent\n');
    return { id, root: made.path, head: commit(box, made.path) };
  });
  cli(box, root, 'add', 'core', 'Main red: both fixture assertions', '--specs', 'G1', '--criterion', 'Both assertions pass.', '--check', 'node test/runner.js test/a.test.js test/b.test.js', '--brief', 'Files: test/a.test.js, test/b.test.js\nTest: real inherited assertions');
  box.cache = join(root, '.git/pullboard/main-red.json');
  writeFileSync(box.cache, JSON.stringify({ version: 1, entries: { [box.main]: { 'test/b.test.js': { result: 'red' } } } }), { mode: 0o600 });
  return box;
}

/** Launch a normal submit and retain its exact terminal output while another process is held. */
function launch(box, builder, mode) {
  const child = startFixtureChild(process.execPath, [BIN, 'submit', String(builder.id), '--json'], { cwd: builder.root, env: { ...box.env, CACHE_CASE: mode }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; let finished = false;
  child.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
  child.stderr.setEncoding('utf8').on('data', part => { stderr += part; });
  const done = new Promise(resolve => child.once('close', (code, signal) => { finished = true; resolve({ code, signal, stdout, stderr }); }));
  return { child, done, finished: () => finished, output: () => stdout + stderr };
}

test('a second submit records fresh main evidence before a held submit finishes, and stale evidence reruns [V4,C7]', async t => {
  const box = fixture(t);
  const [one, two] = box.builders;
  const first = launch(box, one, 'first');
  let second;
  try {
    await observed(() => existsSync(join(box.env.CACHE_CONTROL, 'first.ready')) || first.finished(), 'first submit reaches its real held main comparison');
    assert.equal(first.finished(), false, first.output());
    const resources = new DatabaseSync(join(box.root, '.git/pullboard/resources.sqlite'), { readOnly: true });
    try {
      assert.equal(resources.prepare("SELECT COUNT(*) AS count FROM holder WHERE name='main-red-cache'").get().count, 0, 'a held actual test never holds the cache metadata lease');
    } finally { resources.close(); }
    second = launch(box, two, 'second');
    await observed(() => second.finished(), 'second submit completes while first actual test remains held');
    const completed = await second.done;
    assert.equal(completed.code, 0, completed.stdout + completed.stderr);
    assert.equal(first.finished(), false, 'the first comparison is still blocked by the external test handshake');
    assert.equal(receipt(box, one.id), undefined);
    const recordedSecond = receipt(box, two.id);
    assert.ok(recordedSecond, 'second submit is actually recorded before releasing first');
    const cache = JSON.parse(readFileSync(box.cache, 'utf8'));
    assert.ok(cache.entries[box.main]['test/b.test.js'].failures.length, 'stale file-only cache was replaced by real named failure evidence');
    writeFileSync(join(box.env.CACHE_CONTROL, 'first.release'), 'release');
    const completedFirst = await first.done;
    assert.equal(completedFirst.code, 0, completedFirst.stdout + completedFirst.stderr);
    const recordedFirst = receipt(box, one.id);
    assert.ok(recordedFirst.sequence > recordedSecond.sequence);
    for (const [result, recorded, expected] of [[completedFirst, recordedFirst, ['test/a.test.js','test/b.test.js']], [completed, recordedSecond, ['test/b.test.js']]]) {
      const report = JSON.parse(result.stdout);
      assert.equal(report.gate.green, false, 'actual inherited red remains red in the receipt');
      assert.equal(report.gate.knownMainFailures.main, box.main);
      assert.deepEqual(report.gate.knownMainFailures.failures.map(row => row.file).sort(), expected);
      assert.deepEqual(recorded.detail.submissionProof.knownMainFailures, report.gate.knownMainFailures);
    }
    const runs = readFileSync(join(box.env.CACHE_CONTROL, 'runs.jsonl'), 'utf8').trim().split('\n').map(row => JSON.parse(row));
    assert.deepEqual(runs.filter(row => row.files.includes('test/b.test.js')).map(row => row.mode), ['second'], 'first reuses the fresh result written mid-run rather than executing b again');
  } finally {
    writeFileSync(join(box.env.CACHE_CONTROL, 'first.release'), 'release');
    await first.done;
    if (second) await second.done;
  }
});
