/** @pullboard-test-input source-tree */
/** @pullboard-test-loads src/machine.js */
/** Two items adding different commands, or different engines, merge without conflict even at the same sorted spot [C7,V4]. */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';

const SOURCE = new URL('../src/', import.meta.url);

/** A private Git repository holding a copy of the real registry files, with a runner for private Git calls. */
function registryRepo(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-registry-merge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Merge Fixture', GIT_AUTHOR_EMAIL: 'merge@example.invalid',
    GIT_COMMITTER_NAME: 'Merge Fixture', GIT_COMMITTER_EMAIL: 'merge@example.invalid' });
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  for (const file of files) {
    mkdirSync(join(root, 'src', ...file.split('/').slice(0, -1)), { recursive: true });
    const source = file === 'discovery.js' ? new URL('../packages/kernel/src/core/discovery.js', import.meta.url) : new URL(file, SOURCE);
    cpSync(source, join(root, 'src', file));
  }
  git('init', '-q', '-b', 'main');
  git('add', 'src');
  git('commit', '-q', '-m', 'chore: registry fixture');
  return { root, env, git };
}

/**
 * Commit two independent additions on two branches, then ask Git to merge them. `register` gives each addition a line in
 * a shared list when the repository still keeps one; a discovered registry needs no such line.
 */
function mergeTwo(t, { files, additions, register }) {
  const repo = registryRepo(t, files);
  for (const [index, addition] of additions.entries()) {
    repo.git('checkout', '-q', '-b', `item-${index}`, 'main');
    for (const [file, text] of Object.entries(addition.files)) writeFileSync(join(repo.root, 'src', file), text);
    register?.(repo.root, addition);
    repo.git('add', 'src');
    repo.git('commit', '-q', '-m', `feat: independent addition ${index}`);
  }
  const heads = [0, 1].map((index) => repo.git('rev-parse', `item-${index}`).trim());
  const merge = runFixtureChild('git', ['merge-tree', '--write-tree', ...heads], { cwd: repo.root, env: repo.env, encoding: 'utf8' });
  t.diagnostic(JSON.stringify({ status: merge.status, output: merge.stdout, stderr: merge.stderr }));
  assert.equal(merge.status, 0, 'two independent additions at the same sorted spot must merge cleanly');
  repo.git('checkout', '-q', 'item-0');
  repo.git('merge', '-q', '--no-edit', 'item-1');
  return repo;
}

/** Put a line before the first line that starts with the anchor, when the file still holds a hand-kept list there. */
function listed(file, anchor, line) {
  return (root) => {
    const path = join(root, 'src', file);
    const text = readFileSync(path, 'utf8');
    if (text.split('\n').filter((candidate) => candidate.startsWith(anchor)).length === 1) {
      writeFileSync(path, text.replace(anchor, `${line}\n${anchor}`));
    }
  };
}

test('two commands added at the same sorted spot merge without conflict [C7,V4]', (t) => {
  const commandFiles = readdirSync(new URL('commands/', SOURCE)).filter((file) => file.endsWith('.js')).map((file) => `commands/${file}`);
  const command = (name) => ({ name, files: { [`commands/${name}.js`]: '/** An independent private command. */\nexport function run() { return 0; }\n' } });
  const register = (root, addition) => listed('commands/index.js', "  answer: () => import('./answer.js'),", `  ${addition.name}: () => import('./${addition.name}.js'),`)(root);
  const repo = mergeTwo(t, { files: commandFiles, additions: [command('alpha'), command('alpine')], register });
  const merged = readdirSync(join(repo.root, 'src/commands'));
  assert.ok(merged.includes('alpha.js') && merged.includes('alpine.js'), 'both new commands are in the merged tree');
});

test('two engines added at the same sorted spot merge without conflict [C7,V4]', async (t) => {
  const engineFiles = ['machine.js', 'engine-metadata.js', 'discovery.js', 'engine-numbers.js', ...readdirSync(SOURCE).filter((file) => /-engine\.js$/u.test(file))];
  const engine = (name, number) => ({ name, files: { [`${name}-engine.js`]: `/** An independent private engine. */\nexport const ${name.toUpperCase().replace(/-/gu, '_')}_ENGINE = ${number};\n` } });
  const register = (root, addition) => listed('machine.js', "  'engine-52': 52,", `  '${addition.name}': ${addition.name.endsWith('alpha') ? 63 : 64},`)(root);
  const repo = mergeTwo(t, { files: engineFiles, additions: [engine('check-alpha', 63), engine('check-beta', 64)], register });
  const { discoverEngines } = await import(pathToFileURL(join(repo.root, 'src/machine.js')).href);
  assert.equal(typeof discoverEngines, 'function', 'src/machine.js discovers its engines');
  const found = discoverEngines(pathToFileURL(join(repo.root, 'src/')));
  assert.equal(found['check-alpha'], 63);
  assert.equal(found['check-beta'], 64);
});
