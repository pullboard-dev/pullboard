/**
 * The client start of one next learns where the code comes from with at most one git call, and a checkout whose HEAD
 * is loose is named without any, counted by the spawn recorder [C7].
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { spawnEnv } from '../../tests/fixtures/spawns.js';

const CLIENT = new URL('../../src/io/resident/client.js', import.meta.url).href;

/** The logged git children that learn the tool build: those started under the entry hand-over, the tool selection or the resident client. */
function buildReads(log) {
  return readFileSync(log, 'utf8').split('\n').filter((line) => line.split(' ')[2] === 'git' && /(io\/current\.js|pinned\/tool\/build\.js|resident\/client\.js)/u.test(line));
}

test('next start learns the tool build in one git call [C7]', (t) => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const log = join(box.dir, 'spawns.log');
  fileFixtureItem(box, box.repo, { lane: 'web', title: 'Client one', diagnose: false, args: ['--specs', 'G1'] });
  Object.assign(box.env, spawnEnv(log), { PULLBOARD_SPAWN_STACK: '1' });
  writeFileSync(log, '');
  const result = box.run(box.web, 'next', '--build', '--json');
  assert.equal(result.code, 0, `next: ${result.err}${result.out}`);
  const reads = buildReads(log);
  assert.ok(reads.length <= 1, `next learned the tool build with ${reads.length} git calls:\n${reads.join('\n')}\n${readFileSync(log, 'utf8')}`);
});

test('a command on a loose HEAD names its code without a git call [C7]', (t) => {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const repo = box.repo;
  const git = (...args) => box.git(repo, ...args);
  mkdirSync(join(repo, 'apps/cli'), { recursive: true });
  writeFileSync(join(repo, 'apps/cli/pullboard.js'), 'export {};\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: code');
  const log = join(box.dir, 'codever.log');
  const program = `import { codeVersion } from ${JSON.stringify(CLIENT)}; console.log(JSON.stringify(codeVersion(${JSON.stringify(join(repo, 'apps/cli/pullboard.js'))})));`;
  const versions = [];
  const counts = [];
  for (let run = 0; run < 3; run += 1) {
    writeFileSync(log, '');
    const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', program], { cwd: repo, env: { ...process.env, ...spawnEnv(log) }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.failure ?? result.stderr);
    versions.push(JSON.parse(result.stdout).version);
    counts.push(readFileSync(log, 'utf8').split('\n').filter((line) => line.includes(' git ls-tree')).length);
  }
  assert.match(versions[0], /^code:[0-9a-f]{24}$/u);
  assert.deepEqual(versions, [versions[0], versions[0], versions[0]]);
  assert.deepEqual(counts, [0, 0, 0], 'a loose HEAD is named from its objects, with no Git process');
  writeFileSync(join(repo, 'apps/cli/pullboard.js'), 'export const changed = 1;\n');
  git('commit', '-q', '-am', 'chore: change code');
  writeFileSync(log, '');
  const after = runFixtureChild(process.execPath, ['--input-type=module', '-e', program], { cwd: repo, env: { ...process.env, ...spawnEnv(log) }, encoding: 'utf8' });
  assert.notEqual(JSON.parse(after.stdout).version, versions[0], 'a new HEAD with other code is named anew');
});
