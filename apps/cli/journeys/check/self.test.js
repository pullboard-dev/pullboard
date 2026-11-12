/** A claim holder widens its own frozen check by adding test files; nothing else it may change [C7,V4,H16]. */
import assert from 'node:assert/strict';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import {
  applyEngineMove,
  applyRelayMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
const sandboxes = [];
const SPEC = '# Bar fixture\n\n## G · Goals\n- G1 [approved, must] The feature works. | gate: test\n';
const HOUR = 3_600_000;

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/** Make an isolated real-Git repo with a board, a coordinator, a web builder, a reviewer and three web items. */
async function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-widen-')));
  sandboxes.push(dir);
  const shims = join(dir, 'bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o755 });
  chmodSync(join(shims, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: `${shims}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_') && !name.startsWith('GIT_CONFIG') && !name.startsWith('GIT_AUTHOR') && !name.startsWith('GIT_COMMITTER')) delete env[name];
  delete env.PULLBOARD_RELAY_TOKEN;
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  /** Run Git in this private fixture with its isolated identity. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  /** Run the actual CLI in a fixture checkout and keep both output streams. */
  const run = async (cwd, ...args) => {
    const result = await runCliInProcess(args, { cwd, env });
    return { code: result.status, out: result.stdout ?? '', err: result.failure ?? result.stderr ?? '' };
  };
  /** Run a command that must succeed with --json and return its one document. */
  const json = async (cwd, ...args) => {
    const result = await run(cwd, ...args, '--json');
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
    return JSON.parse(result.out);
  };
  git(repo, 'init', '-q', '-b', 'main');
  assert.equal((await run(repo, 'init')).code, 0);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({
    gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h',
    lanes: { web: { owns: ['web/', 'test/', 'packages/gate/src/io/run/', 'packages/codemap/src/io/cells/scripts/'], specs: ['G1'] } },
  }, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  mkdirSync(join(repo, 'web'));
  writeFileSync(join(repo, 'web', 'shared.txt'), 'base\n');
  // The comment case below names this journey's own path in a check, and the bar must find it on main.
  mkdirSync(join(repo, 'apps/cli/journeys/check'), { recursive: true });
  writeFileSync(join(repo, 'apps/cli/journeys/check/self.test.js'), '\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore: create bar fixture');
  const web = (await json(repo, 'worktree', 'web', '--route', 'strong')).path;
  const review = (await json(repo, 'worktree', 'web', '--route', 'strong')).path;
  await json(repo, 'add', 'web', 'Widened item', '--specs', 'G1', '--criterion', 'Widened item works', '--check', 'node packages/gate/src/io/run/tests.js test/a.test.js && node packages/codemap/src/io/cells/scripts/plan.js --cuts x && node packages/gate/src/io/run/tests.js --test-force-exit test/b.test.js');
  await json(repo, 'add', 'web', 'Unclaimed item', '--specs', 'G1', '--criterion', 'Unclaimed works', '--check', 'node packages/gate/src/io/run/tests.js test/a.test.js');
  return { repo, web, review, run, json, git };
}


/** Edit one item's check as an agent from a folder and return the parsed error code, or null. */
async function tryCheck(box, cwd, check) {
  const result = await box.run(cwd, 'edit', '1', '--check', check, '--json');
  return { code: result.code, error: result.code === 0 ? null : JSON.parse(result.out).error };
}

test('[C7,V4,H16] a holder adds test files to its own check; removing a file or changing the command is refused by name', async () => {
  const box = await fixture();
  const original = (await box.json(box.repo, 'show', '1')).item_check;

  const unclaimed = await tryCheck(box, box.web, `${original} test/c.test.js`);
  assert.notEqual(unclaimed.code, 0, 'a builder that does not hold the item may not edit its check');

  (await box.json(box.web, 'claim', '1'));
  const widened = 'node packages/gate/src/io/run/tests.js test/a.test.js test/c.test.js && node packages/codemap/src/io/cells/scripts/plan.js --cuts x && node packages/gate/src/io/run/tests.js --test-force-exit test/b.test.js test/d.test.js';
  const ok = await tryCheck(box, box.web, widened);
  assert.equal(ok.code, 0, JSON.stringify(ok.error));
  const shown = (await box.json(box.repo, 'show', '1'));
  assert.equal(shown.item_check, widened, 'the check is updated');
  assert.equal(shown.item_status, 'claimed');
  assert.equal(shown.item_owner, 'web-1', 'the claim is kept');
  assert.equal(JSON.parse(shown.item_frozen).sourceCheck ?? JSON.parse(shown.item_frozen).check, widened, 'the frozen bar carries the widened check at once');
  const edits = shown.thread.filter((entry) => entry.type === 'move' && entry.kind === 'edit');
  assert.equal(edits.length, 1, 'one event records the widening');
  assert.deepEqual(edits[0].detail.widenedCheck, ['test/c.test.js', 'test/d.test.js'], 'the event names the added files');
  assert.equal(edits[0].detail.barCorrection, undefined, 'a widening is not a bar correction');
  assert.equal(edits[0].by, 'web-1');

  const removed = await tryCheck(box, box.web, widened.replace(' test/c.test.js', ''));
  assert.equal(removed.error?.code, 'CHECK_WIDEN_REFUSED');
  assert.match(removed.error.message, /differs at character \d+/, 'a removed file is refused by position');

  const command = await tryCheck(box, box.web, widened.replace('node packages/codemap/src/io/cells/scripts/plan.js --cuts x', 'node packages/codemap/src/io/cells/scripts/plan.js --cuts y'));
  assert.equal(command.error?.code, 'CHECK_WIDEN_REFUSED');
  assert.match(command.error.message, /differs at character \d+/, 'a changed command is refused by position');

  const flags = await tryCheck(box, box.web, widened.replace(' --test-force-exit', ''));
  assert.equal(flags.error?.code, 'CHECK_WIDEN_REFUSED');
  assert.match(flags.error.message, /differs at character \d+/, 'changed flags are refused');

  const injected = await tryCheck(box, box.web, `${widened}; rm -rf x`);
  assert.equal(injected.error?.code, 'CHECK_WIDEN_REFUSED', 'shell syntax is not a plain test file');
  assert.equal((await box.json(box.repo, 'show', '1')).item_check, widened, 'refused edits change nothing');

  const reordered = await tryCheck(box, box.web, 'node packages/gate/src/io/run/tests.js --test-name-pattern test/b.test.js test/a.test.js test/c.test.js');
  assert.equal(reordered.error?.code, 'CHECK_WIDEN_REFUSED', 'an unrelated check is refused');
  assert.equal((await box.json(box.repo, 'edit', '1', '--check', 'node packages/gate/src/io/run/tests.js --test-name-pattern test/a.test.js test/b.test.js', '--reason', 'set up the option case')).item.item_check, 'node packages/gate/src/io/run/tests.js --test-name-pattern test/a.test.js test/b.test.js');
  const swapped = await tryCheck(box, box.web, 'node packages/gate/src/io/run/tests.js --test-name-pattern test/b.test.js test/a.test.js test/c.test.js');
  assert.equal(swapped.error?.code, 'CHECK_WIDEN_REFUSED', 'the option value changed from a to b, so adding c is refused');
  assert.match(swapped.error.message, /differs at character \d+/);
  assert.equal((await tryCheck(box, box.web, 'node packages/gate/src/io/run/tests.js --test-name-pattern test/a.test.js test/b.test.js test/c.test.js')).code, 0, 'the same option with an added file is accepted');

  (await box.json(box.repo, 'edit', '1', '--check', "test 'a  b' = 'a  b' && node packages/gate/src/io/run/tests.js test/a.test.js", '--reason', 'set up the quote case'));
  const quoted = await tryCheck(box, box.web, "test 'a b' = 'a  b' && node packages/gate/src/io/run/tests.js test/a.test.js test/c.test.js");
  assert.equal(quoted.error?.code, 'CHECK_WIDEN_REFUSED', 'whitespace inside quotes changed, so adding c is refused');
  assert.equal((await tryCheck(box, box.web, "test 'a  b' = 'a  b' && node packages/gate/src/io/run/tests.js test/a.test.js test/c.test.js")).code, 0, 'appending to the byte-identical frozen check is accepted');
  assert.equal((await tryCheck(box, box.web, "test 'a  b' = 'a  b' && node packages/gate/src/io/run/tests.js test/a.test.js test/c.test.js test/c.test.js")).error?.code, 'CHECK_WIDEN_REFUSED', 'a file already present is refused');

  (await box.json(box.repo, 'edit', '1', '--check', 'node packages/gate/src/io/run/tests.js apps/cli/journeys/check/self.test.js # review-control', '--reason', 'set up the comment case'));
  const commented = await tryCheck(box, box.web, 'node packages/gate/src/io/run/tests.js apps/cli/journeys/check/self.test.js # review-control test/review-control-missing.test.js');
  assert.equal(commented.error?.code, 'CHECK_WIDEN_REFUSED', 'a path appended after a shell comment never runs, so it is refused');
  assert.match(commented.error.message, /not a plain node apps\/cli\/src\/io\/run\/tests\.js part/);

  const criterion = await box.run(box.web, 'edit', '1', '--criterion', 'easier', '--json');
  assert.notEqual(criterion.code, 0, 'a builder still cannot edit anything but the check');

  const coordinator = (await box.json(box.repo, 'edit', '1', '--check', 'true', '--reason', 'the coordinator still changes any check'));
  assert.equal(coordinator.item.item_check, 'true');
});
