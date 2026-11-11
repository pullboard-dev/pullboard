import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { runFixtureChild } from '../../../fixtures/child.js';
import { runFixtureGit } from '../../../fixtures/child.js';
import { trustedStepCommand } from '../../../../src/io/submit/gate.js';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' };

/**
 * Run a trusted step whose entry writes a result line over 64 KiB in chunks, a warning between chunks, with stdout and stderr on one pipe.
 * Why one pipe: the runner reads the result from a stream the step's stderr can reach; this is the worst case for splicing.
 */
function runStep(entry) {
  const root = privateFixtureFiles('large-result-').root;
  try {
    const git = (...args) => runFixtureGit(args, { cwd: root, env: ENV });
    const init = runFixtureChild('git', ['init', '--quiet', '-b', 'main'], { cwd: root, env: ENV, encoding: 'utf8' });
    assert.equal(init.status, 0, init.failure);
    writeFileSync(join(root, 'a.txt'), 'x\n');
    git('add', '.');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'one');
    const main = git('rev-parse', 'HEAD');
    const command = trustedStepCommand({ main, entry, data: {} });
    const run = spawnSync('/bin/sh', ['-c', `(${command}) 2>&1`], { cwd: root, env: ENV, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2 });
    return { main, run };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('clause 1: a result line over 64 KiB with warnings on stderr parses and binds to main and source [C7]', () => {
  const entry = `import { DatabaseSync } from 'node:sqlite';
const root = process.argv[2];
const result = { main: process.env.MAIN_PIN ?? '', source: 's'.repeat(40), files: Array.from({ length: 4000 }, (_, i) => 'test/file-' + i + '.test.js') };
const text = 'PULLBOARD_TRUSTED_RESULT ' + JSON.stringify(result) + '\\n';
new DatabaseSync(':memory:').close();
for (let at = 0; at < text.length; at += 16384) {
  process.stdout.write(text.slice(at, at + 16384));
  process.emitWarning('chunk edge ' + at, 'ExperimentalWarning');
  process.stderr.write('(Use node --trace-warnings) warning at ' + at + '\\n');
}
`;
  const { run } = runStep(entry);
  const rows = run.stdout.split(/\r?\n/u).filter(line => line.startsWith('PULLBOARD_TRUSTED_RESULT '));
  assert.equal(rows.length, 1);
  assert.ok(rows[0].length > 64 * 1024);
  const value = JSON.parse(rows[0].slice('PULLBOARD_TRUSTED_RESULT '.length));
  assert.equal(value.source, 's'.repeat(40));
  assert.equal(value.files.length, 4000);
  assert.match(run.stdout, /warning at 0/u);
});

test('clause 2: the step is spawned with stderr separate and ExperimentalWarning disabled [C7]', () => {
  const entry = `process.stdout.write('PULLBOARD_TRUSTED_RESULT ' + JSON.stringify({ argv: process.execArgv }) + '\\n');
process.stderr.write('late warning\\n');
`;
  const { run } = runStep(entry);
  const line = run.stdout.split(/\r?\n/u).find(row => row.startsWith('PULLBOARD_TRUSTED_RESULT '));
  assert.ok(line, run.stdout);
  assert.ok(JSON.parse(line.slice(25)).argv.includes('--disable-warning=ExperimentalWarning'));
  assert.ok(run.stdout.indexOf('late warning') > run.stdout.indexOf(line) + line.length - 1, 'stderr is replayed after the whole result line');
});
