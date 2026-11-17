/** The gate journeys' shared repo fixture: a repo whose coordinator holds item #1 under a given gate [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFixtureGit } from '../child.js';
import { runCliInProcess } from '../process.js';
import { fixtureMachineSettings } from '../testkit.js';

/**
 * Bind repoWithGate to a list of temp dirs, so the calling test file removes them when it ends.
 *
 * @param {string[]} dirs
 */
export function gateRepoFixture(dirs) {
  /** The persona name the gate fixtures join under. */
  const FIXTURE_AGENT = 'Test Agent';

  /**
   * A repo whose coordinator holds item #1, with this gate. Every run of the gate first adds a line
   * to runs.log beside the repo, so a test can count the runs.
   *
   * @param {string} gate
   * @param {string} [check]
   */
  async function repoWithGate(gate, check = '') {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-gate-')));
    dirs.push(dir);
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test Agent',
      GIT_AUTHOR_EMAIL: 'agent@example.com',
      GIT_COMMITTER_NAME: 'Test Agent',
      GIT_COMMITTER_EMAIL: 'agent@example.com',
      PULLBOARD_HOME: join(dir, 'home'),
      PULLBOARD_MACHINE_HOME: join(dir, 'home'),
    };
    // These cases assert submit running the gate in the command; the gate runs on a pulled runner [P7].
    mkdirSync(env.PULLBOARD_MACHINE_HOME, { recursive: true });
    // The fixture also has no local runner: a baseline waits as pending instead of running on whatever host runs this file (#2520).
    fixtureMachineSettings(env.PULLBOARD_MACHINE_HOME, { gate: { localRunner: false } });
    // The fixture's checks and gates are their own test runs, not children of this one.
    delete env.NODE_TEST_CONTEXT;
    const git = (...args) => runFixtureGit(args, { cwd: repo, env });
    const run = (...args) => runCliInProcess(args, { cwd: repo, env });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: `echo run >> ../runs.log; ${gate}`, lanes: { build: { owns: ['WORK', 'RED', 'fixtures/'] } } }));
    writeFileSync(join(repo, 'SPEC.md'), '# Demo\n\n## G · Goals\n- G1 [approved, must] It works. | gate: test\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: a spec');
    const added = await run('add', 'build', 'Work', '--route', 'mid', '--brief', 'Files:\n- fixtures/WORK\n\nTest:\nthe fixture gate behaves as asserted.', '--criterion', 'The gate behaves as asserted.', ...(check ? ['--check', check, '--wait'] : ['--check', 'true']));
    assert.equal(added.status, 0, `${added.stdout}${added.stderr}`);
    // Submissions need their own committed delta; main itself is not an item change. Accepted main is the primary
    // checkout's HEAD, so the item work lives in a linked worktree and the primary checkout stays on main.
    const work = join(dir, 'work');
    git('worktree', 'add', '-q', '-b', 'coordinator/item-1', work);
    const workGit = (...args) => runFixtureGit(args, { cwd: work, env });
    writeFileSync(join(work, 'WORK'), 'item change\n');
    workGit('add', 'WORK');
    workGit('commit', '-q', '-m', 'chore: make the fixture item change');
    const runs = () => {
      try {
        return readFileSync(join(dir, 'runs.log'), 'utf8').split('\n').filter(Boolean).length;
      } catch {
        return 0;
      }
    };
    const runAt = (...args) => runCliInProcess(args, { cwd: work, env });
    const joined = await runAt('join', 'build', '--model', FIXTURE_AGENT);
    assert.equal(joined.status, 0, `${joined.stdout}${joined.stderr}`);
    const claimed = await runAt('claim', '1');
    assert.equal(claimed.status, 0, `${claimed.stdout}${claimed.stderr}`);
    return { dir, repo: work, primary: repo, env, git: workGit, primaryGit: git, runLocal: runAt, runs };
  }
  return repoWithGate;
}
