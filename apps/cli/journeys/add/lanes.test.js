/** Which lanes take which items: a lane that owns no files takes review items only [I1]. */
import assert from 'node:assert/strict';
import {
  appendFileSync,
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
import { test } from 'node:test';
import {
  runFixtureChild,
  runFixtureGit,
} from "../../tests/fixtures/child.js";
import {
  AGENT_SHELL_MARKERS,
  SSH_SHELL_MARKERS,
} from "../../../../packages/kernel/index.js";

const BIN = resolve(import.meta.dirname, '../../pullboard.js');

const LANES = { web: { owns: ['web/'] }, api: { owns: ['api/'] }, review: { owns: [] } };

/** A committed pullboard repo with the given lanes: by default two that own files and a review lane. */
function project(t, lanes = LANES) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-add-lanes-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The repo's hooks call pullboard, so a shim on the PATH runs this checkout's CLI.
  const shims = join(root, '.bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(shims, 'pullboard'), 0o755);
  const env = {
    ...process.env, PATH: `${shims}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(root, '.private-home'), PULLBOARD_MACHINE_HOME: join(root, '.machine-home'),
  };
  for (const marker of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[marker];
  delete env.PULLBOARD_RELAY_TOKEN;
  /** Run git in the fixture without the maintainer's configuration. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  /** Run the CLI as the coordinator and keep its output for the assertions. */
  const run = (...args) => {
    const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout, err: result.failure ?? result.stderr };
  };
  git('init', '-q', '-b', 'main');
  assert.equal(run('init').code, 0);
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({
    gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h', shared: [],
    lanes,
  }, null, 2));
  writeFileSync(join(root, 'SPEC.md'), '# Demo spec\n\n## G · Goals\n- G1 [approved, must] The page renders. | gate: web test\n');
  appendFileSync(join(root, '.gitignore'), '.bin/\n.private-home/\n.machine-home/\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: set up pullboard');
  return { run };
}

test('add refuses a build item in a review lane [I1]', (t) => {
  const box = project(t);
  const build = box.run('add', 'review', 'Upload page', '--specs', 'G1');
  assert.notEqual(build.code, 0, 'a build item in a lane that owns no files is refused');
  assert.match(build.err, /NO_FILES_LANE/u);
  assert.match(build.err, /the review lane owns no files/u);
  assert.match(build.err, /file it in a lane that owns files \(web, api\)/u, 'the refusal names the lanes that own files');
  assert.match(build.err, /or pass --after <id> if it reviews that item/u, 'the refusal gives the review next step');
  assert.doesNotMatch(box.run('list', '--all').out, /Upload page/u, 'nothing was filed');

  const work = box.run('add', 'web', 'Upload page', '--specs', 'G1');
  assert.equal(work.code, 0, work.err);
  const id = work.out.match(/#(\d+)/u)[1];
  const review = box.run('add', 'review', 'Review the upload page', '--after', id);
  assert.equal(review.code, 0, review.err);
  const reviewId = review.out.match(/#(\d+)/u)[1];
  const shown = box.run('show', reviewId);
  assert.match(shown.out, /review\s+Review the upload page/u, 'an item with --after is added to the review lane as before');
  assert.match(shown.out, new RegExp(`#${id}`, 'u'), 'it still waits on the work it reviews');

  const fresh = project(t, { review: { owns: [] } });
  const early = fresh.run('add', 'review', 'First task', '--specs', 'G1');
  assert.equal(early.code, 0, `with no lane owning files yet, as right after init, add works as before: ${early.err}`);
  assert.match(fresh.run('list', 'review').out, /First task/u);
});
