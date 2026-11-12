/** @pullboard-test-input apps/cli/pullboard.js */
/**
 * Submit asks why when a change edits an existing test or gate file, and a new test file needs no reason [C7,V4].
 * Drives the real CLI in process.
 */
import assert from 'node:assert/strict';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { waitForCondition } from '../../tests/fixtures/runner/holders.js';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';

const BIN = join(import.meta.dirname, '../../pullboard.js');
const SPEC = '# Submit proof fixture\n\n## G · Goals\n- G1 [approved, must] The selected test proves the change. | gate: test\n';
const dirs = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Finish only this fixture's detached observations before the active case ends and cleanup removes its board. */
async function drainComparisons(box, t) {
  const directory = join(box.dir, 'repo/.git/pullboard/review-comparisons');
  const jobs = existsSync(directory) ? readdirSync(directory).map(job => join(directory, job)) : [];
  await waitForCondition(() => jobs.every(job => existsSync(join(job, 'result.json'))),
    'owned submit-infra comparison to finish', { signal: t.signal });
}

/** Write a fixture file, creating its parent directory when needed. */
function put(root, path, text) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Commit the fixture state using a valid Pullboard message. */
function commitAll(box, message = 'chore: fixture state') {
  box.git('add', '-A');
  box.git('commit', '-q', '-m', message);
  return box.git('rev-parse', 'HEAD');
}

/** Create a private Git repository with a deterministic identity and isolated Pullboard home. */
async function privateRepo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-submit-infra-')));
  dirs.push(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  mkdirSync(root);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  };
  delete env.PULLBOARD_RELAY_TOKEN;
  delete env.NODE_TEST_CONTEXT;
  /** Run real Git in this fixture with only the fixture's configured identity. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  /** Run the real local CLI, retaining JSON stdout and refusal stderr separately. */
  const run = async (...args) => {
    if (['add', 'submit'].includes(args[0])) args.push('--wait');
    if (['submit', 'verify'].includes(args[0])) args.push('--no-next');
    return await runCliInProcess(args, { cwd: root, env });
  };
  git('init', '-q', '-b', 'main');
  assert.equal((await run('init')).code, 0);
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  symlinkSync(BIN, join(root, 'node_modules/.bin/pullboard'));
  appendFileSync(join(root, '.git/info/exclude'), '\nnode_modules/\n');
  put(root, 'SPEC.md', SPEC);
  put(root, 'package.json', '{"type":"module"}\n');
  return { dir, root, env, git, run };
}

/** Create a real joined builder while the coordinator stays on its unchanged trunk. */
async function builderRepo(box, { requireInfraNote = true, extraOwns = [] } = {}) {
  const config = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  config.lanes = { build: { owns: ['src/', 'test/', ...extraOwns], specs: ['G'] } };
  if (requireInfraNote) config.submit = { requireInfraNote: true };
  put(box.root, 'pullboard.json', JSON.stringify(config));
  commitAll(box);
  const made = await box.run('worktree', 'build', '--model', 'fixture-agent', '--json');
  assert.equal(made.code, 0, made.err);
  const root = JSON.parse(made.out).path;
  /** Run Git only in the joined builder. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env: box.env });
  /** Run the real CLI with the joined builder identity. */
  const run = async (...args) => {
    if (['add', 'submit'].includes(args[0])) args.push('--wait');
    if (['submit', 'verify'].includes(args[0])) args.push('--no-next');
    return await runCliInProcess(args, { cwd: root, env: box.env });
  };
  return { ...box, root, git, run, coordinator: box.run };
}

/** Commit one change to a builder checkout, then return the item's builder repository. */
async function infraBox(t, { edit, existing = true, requireInfraNote = true, files = ['test/existing.test.js'] }) {
  let box = await privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'true', spec: 'SPEC.md' }));
  put(box.root, 'SPEC.md', SPEC);
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  if (existing) put(box.root, 'test/existing.test.js', "import '../src/a.js';\n");
  commitAll(box);
  box = await builderRepo(box, { requireInfraNote });
  const added = await box.coordinator('add', 'build', 'Infra note fixture', '--criterion', 'the submit handles the changed fixture path',
    '--check', 'true', '--route', 'strong', '--brief', `Files:\n- ${files.join('\n- ')}\nChange: exercise infrastructure-note handling for the submitted path.\nTest: verify the note behavior for the changed file.\nOut of scope: product behavior.`);
  assert.equal(added.code, 0, `${added.out}\n${added.err}`);
  assert.equal((await box.run('claim', '1')).code, 0);
  edit(box);
  commitAll(box, 'feat(core): change the item [G1]');
  return box;
}

test('submit drafts a note when a change edits an existing test [C7,V4]', async (t) => {
  const box = await infraBox(t, { edit: (box) => put(box.root, 'test/existing.test.js', "import '../src/a.js';\n// a reason\n") });
  const submitted = await box.run('submit', '1');
  assert.equal(submitted.code, 0, `${submitted.out}\n${submitted.err}`);
  const shown = await box.run('show', '1');
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /infra note:/u, 'the reviewer reads the drafted note in show');
  assert.match(shown.out, /test\/existing\.test\.js/u, 'show names the edited file');
  await drainComparisons(box, t);
});

test('a supplied infra note is retained and an enabled board drafts one [C7,V4]', async (t) => {
  /** Edit an existing test file after the item claim. */
  const edit = (box) => put(box.root, 'test/existing.test.js', "import '../src/a.js';\n// a change\n");
  const optional = await infraBox(t, { edit, requireInfraNote: false });
  const accepted = await optional.run('submit', '1');
  assert.equal(accepted.code, 0, `${accepted.out}\n${accepted.err}`);
  assert.doesNotMatch(`${accepted.out}\n${accepted.err}`, /INFRA_NOTE_REQUIRED/u);

  const recorded = await infraBox(t, { edit, requireInfraNote: false });
  const noted = await recorded.run('submit', '1', '--infra', 'the change keeps the real listener covered');
  assert.equal(noted.code, 0, `${noted.out}\n${noted.err}`);
  const shown = await recorded.run('show', '1');
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /infra note: the change keeps the real listener covered/u);
  assert.match(shown.out, /test\/existing\.test\.js/u);

  const enabled = await infraBox(t, { edit, requireInfraNote: true });
  const drafted = await enabled.run('submit', '1');
  assert.equal(drafted.code, 0, `${drafted.out}\n${drafted.err}`);
  assert.match((await enabled.run('show', '1')).out, /infra note:/u);
  for (const box of [optional, recorded, enabled]) await drainComparisons(box, t);
});

test('a new test file needs no note [C7,V4]', async (t) => {
  const box = await infraBox(t, { existing: true, files: ['test/brand-new.test.js'], edit: (box) => put(box.root, 'test/brand-new.test.js', "import '../src/a.js';\n") });
  const submitted = await box.run('submit', '1');
  assert.equal(submitted.code, 0, `${submitted.out}\n${submitted.err}`);
  assert.doesNotMatch(`${submitted.out}\n${submitted.err}`, /INFRA_NOTE_REQUIRED/u);
  await drainComparisons(box, t);
});

test('a gate named by a quoted path or a shell separator receives a drafted note [C7,V4]', async (t) => {
  // Each gate names a script the change then edits: a quoted path with a space, and a path followed by a separator.
  // An unnormalized path names the same file Git reports, so it needs the note too (#814 review).
  for (const [gate, file] of [["node 'src/check gate.js'", 'src/check gate.js'], ['node src/check.js; true', 'src/check.js'],
    ['node src/../src/check.js', 'src/check.js'], ['node ./src/./check.js', 'src/check.js']]) {
    let box = await privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate, spec: 'SPEC.md' }));
    put(box.root, file, 'process.exit(0);\n');
    commitAll(box);
    box = await builderRepo(box, { extraOwns: ['gate.js'] });
    const added = await box.coordinator('add', 'build', 'Gate named by a path', '--criterion', 'the submit handles the changed gate path',
      '--check', 'true', '--route', 'strong', '--brief', `Files:\n- ${file}\nChange: exercise infrastructure-note handling for the gate path.\nTest: verify the note behavior for the changed file.\nOut of scope: product behavior.`);
    assert.equal(added.code, 0, `${added.out}\n${added.err}`);
    assert.equal((await box.run('claim', '1')).code, 0);
    put(box.root, file, 'process.exit(0); // edited after the claim\n');
    commitAll(box, 'feat(core): change the gate script [G1]');
    const submitted = await box.run('submit', '1');
    assert.equal(submitted.code, 0, `${gate}: ${submitted.out}\n${submitted.err}`);
    const shown = await box.run('show', '1');
    assert.match(shown.out, /infra note:/u);
    assert.ok(shown.out.includes(file), `${gate}: the note names ${file}`);
    await drainComparisons(box, t);
  }
});
