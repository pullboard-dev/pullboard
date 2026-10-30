/** Real private flake projects own their counter and native board evidence bytes [C7,H16]. */
import assert from 'node:assert/strict';
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../../test/fixture-child.js';

const BIN = resolve(import.meta.dirname, '../../../bin/pullboard.js');
export const TITLE = 'a controlled intermittent assertion [C7]';

/** Initialize a real private board and Git history; all gate commands use only this synthetic project. */
export function flakyProject(t, { rerun = true, reporter = 'tap', alwaysPass = false } = {}) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-native-flake-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'repo'); mkdirSync(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture Agent', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture Agent', GIT_COMMITTER_EMAIL: 'fixture@example.com',
    PULLBOARD_HOME: join(scratch, 'home'), PULLBOARD_MACHINE_HOME: join(scratch, 'machine'), PULLBOARD_VIEW_BACKGROUND: '0' };
  delete env.PULLBOARD_RELAY_TOKEN; delete env.NODE_TEST_CONTEXT;
  /** Run Git only within this fixture with a private deterministic identity. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  /** Exercise the real CLI, retaining only its structured receipt for assertions. */
  const cliAt = (cwd, ...args) => {
    const result = runFixtureChild(process.execPath, [BIN, ...args, '--json'], { cwd, env, encoding: 'utf8' });
    return { code: result.status, document: result.stdout?.trim() ? JSON.parse(result.stdout) : null, failure: result.failure };
  };
  /** Keep the coordinator's normal command path separate from its actual joined worktrees. */
  const cli = (...args) => cliAt(root, ...args);
  git('init', '-q', '-b', 'main');
  assert.equal(cli('init').code, 0);
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  symlinkSync(BIN, join(root, 'node_modules/.bin/pullboard'));
  appendFileSync(join(root, '.git/info/exclude'), '\nnode_modules/\n');
  const file = join(root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.gate = `node --test --test-reporter=${reporter} test/alternating.test.mjs`;
  config.flakes = rerun === null ? undefined : { rerun };
  // These fixtures test coupled gate-before-push, independently of init's no-remote default.
  delete config.landing;
  // These synthetic checks intentionally match the already-configured gate; a private warning policy permits the controlled failure to be armed after submission.
  config.checks = { ...config.checks, provesNothing: 'warn' };
  config.lanes = { build: { owns: ['src/', 'test/'], specs: [] } };
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  mkdirSync(join(root, 'test'));
  const counter = join(scratch, 'observed-target-runs');
  if (alwaysPass === 'controlled') writeFileSync(counter + '.mode', 'pass');
  writeTarget(root, counter, alwaysPass);
  git('add', '-A'); git('commit', '-q', '-m', 'chore: prepare private flake fixture');
  /** Read real private evidence only from this freshly owned counter or board evidence directory. */
  function readData(file, encoding) {
    if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('private flake evidence requires an absolute file');
    const path = resolve(file), evidence = join(root, '.git/pullboard');
    const within = relative(evidence, path);
    if (path !== counter && (!within || within === '..' || within.startsWith('..' + sep) || isAbsolute(within))) {
      throw new Error('private flake evidence escaped its counter or board evidence');
    }
    let current = scratch;
    const parts = relative(scratch, path).split(sep);
    if (lstatSync(current).isSymbolicLink()) throw new Error('private flake evidence root is symbolic');
    for (const part of parts) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (current === path ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error('private flake evidence is not a contained regular file');
      }
    }
    return readFileSync(path, encoding);
  }
  return { root, scratch, env, git, cli, cliAt, counter, readData, lane: 'build' };
}

/** Keep the exact same test identity on main and a candidate, with independently controlled behavior. */
export function writeTarget(root, counter, alwaysPass = false, mutate = false) {
  const assertion = "assert.equal(readFileSync(marker, 'utf8').trim().split('\\n').length % 2, 0);";
  writeFileSync(join(root, 'test/alternating.test.mjs'), `import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
/** Record real executions; the fixture controls whether the assertion is passing or intermittent. */
test(${JSON.stringify(TITLE)}, () => {
  const marker = ${JSON.stringify(counter)};
  appendFileSync(marker, 'run\\n');
  ${mutate ? (mutate === 'controlled' ? "if (readFileSync(marker + '.mode', 'utf8') !== 'pass') " : '') + 'appendFileSync(new URL(import.meta.url), ' + JSON.stringify('\n// fixture source changed\n') + ');' : ''}
  ${alwaysPass === 'controlled' ? "if (readFileSync(marker + '.mode', 'utf8') !== 'pass') " + assertion : alwaysPass ? 'assert.ok(true);' : assertion}
});\n`);
}
