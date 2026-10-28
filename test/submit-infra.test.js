/** @pullboard-test-input source-tree */
/**
 * Submit asks why when a change edits an existing test or gate file, and a new test file needs no reason [C7,V4].
 */
import assert from 'node:assert/strict';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { configFromSource } from '../src/config.js';

const BIN = join(import.meta.dirname, '../bin/pullboard.js');
const SPEC = '# Submit proof fixture\n\n## G · Goals\n- G1 [approved, must] The selected test proves the change. | gate: test\n';
const dirs = [];

test('infra-note settings default off and refuse non-boolean policies [C7,V4]', () => {
  assert.equal(configFromSource('{}').submit.requireInfraNote, false);
  assert.equal(configFromSource('{"submit":{}}').submit.requireInfraNote, false);
  assert.equal(configFromSource('{"submit":{"requireInfraNote":true}}').submit.requireInfraNote, true);
  for (const submit of [null, [], true, { requireInfraNote: 'true' }, { requireInfraNote: 1 }, { requireInfraNote: null }, { requireInfraNotes: true }]) {
    assert.throws(() => configFromSource(JSON.stringify({ submit })), error => error.code === 'BAD_CONFIG');
  }
});

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

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
function privateRepo(t) {
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
  const run = (...args) => {
    const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout ?? '', err: result.failure ?? result.stderr ?? '', failure: result.failure };
  };
  git('init', '-q', '-b', 'main');
  assert.equal(run('init').code, 0);
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  symlinkSync(BIN, join(root, 'node_modules/.bin/pullboard'));
  appendFileSync(join(root, '.git/info/exclude'), '\nnode_modules/\n');
  put(root, 'SPEC.md', SPEC);
  put(root, 'package.json', '{"type":"module"}\n');
  return { dir, root, env, git, run };
}

/** Create a real joined builder while the coordinator stays on its unchanged trunk. */
function builderRepo(box, { requireInfraNote = true } = {}) {
  const config = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  config.lanes = { build: { owns: ['src/', 'test/'], specs: ['G'] } };
  if (requireInfraNote) config.submit = { requireInfraNote: true };
  put(box.root, 'pullboard.json', JSON.stringify(config));
  commitAll(box);
  const made = box.run('worktree', 'build', '--json');
  assert.equal(made.code, 0, made.err);
  const root = JSON.parse(made.out).path;
  /** Run Git only in the joined builder. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env: box.env });
  /** Run the real CLI with the joined builder identity. */
  const run = (...args) => {
    const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd: root, env: box.env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout ?? '', err: result.failure ?? result.stderr ?? '', failure: result.failure };
  };
  return { ...box, root, git, run, coordinator: box.run };
}

/** Commit one change to a builder checkout, then return the item's builder repository. */
function infraBox(t, { edit, existing = true, requireInfraNote = true }) {
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'true', spec: 'SPEC.md' }));
  put(box.root, 'SPEC.md', SPEC);
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  if (existing) put(box.root, 'test/existing.test.js', "import '../src/a.js';\n");
  commitAll(box);
  box = builderRepo(box, { requireInfraNote });
  assert.equal(box.coordinator('add', 'build', 'Infra note fixture', '--check', 'true').code, 0);
  assert.equal(box.run('claim', '1').code, 0);
  edit(box);
  commitAll(box, 'feat(core): change the item [G1]');
  return box;
}

test('submit asks why when a change edits an existing test [C7,V4]', (t) => {
  const box = infraBox(t, { edit: (box) => put(box.root, 'test/existing.test.js', "import '../src/a.js';\n// a reason\n") });
  const refused = box.run('submit', '1');
  assert.equal(refused.code, 1, `${refused.out}\n${refused.err}`);
  const refusal = `${refused.out}\n${refused.err}`;
  assert.match(refusal, /INFRA_NOTE_REQUIRED/u, 'submit refuses an unexplained edit to an existing test');
  assert.match(refusal, /test\/existing\.test\.js/u, 'the refusal names the file');
  assert.match(refusal, /--infra/u, 'the refusal says how to give the reason');

  const submitted = box.run('submit', '1', '--infra', 'the listener shim hid a real socket');
  assert.equal(submitted.code, 0, `${submitted.out}\n${submitted.err}`);
  const shown = box.run('show', '1');
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /infra note: the listener shim hid a real socket/u, 'the reviewer reads the note in show');
  assert.match(shown.out, /test\/existing\.test\.js/u, 'show names the edited file');
});

test('the infra note is required only when the board turns it on [C7,V4]', (t) => {
  /** Edit an existing test file after the item claim. */
  const edit = (box) => put(box.root, 'test/existing.test.js', "import '../src/a.js';\n// a change\n");
  const optional = infraBox(t, { edit, requireInfraNote: false });
  const accepted = optional.run('submit', '1');
  assert.equal(accepted.code, 0, `${accepted.out}\n${accepted.err}`);
  assert.doesNotMatch(`${accepted.out}\n${accepted.err}`, /INFRA_NOTE_REQUIRED/u);

  const recorded = infraBox(t, { edit, requireInfraNote: false });
  const noted = recorded.run('submit', '1', '--infra', 'the change keeps the real listener covered');
  assert.equal(noted.code, 0, `${noted.out}\n${noted.err}`);
  const shown = recorded.run('show', '1');
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /infra note: the change keeps the real listener covered/u);
  assert.match(shown.out, /test\/existing\.test\.js/u);

  const enabled = infraBox(t, { edit, requireInfraNote: true });
  const refused = enabled.run('submit', '1');
  assert.equal(refused.code, 1, `${refused.out}\n${refused.err}`);
  assert.match(`${refused.out}\n${refused.err}`, /INFRA_NOTE_REQUIRED/u);
});

test('a new test file needs no note [C7,V4]', (t) => {
  const box = infraBox(t, { existing: true, edit: (box) => put(box.root, 'test/brand-new.test.js', "import '../src/a.js';\n") });
  const submitted = box.run('submit', '1');
  assert.equal(submitted.code, 0, `${submitted.out}\n${submitted.err}`);
  assert.doesNotMatch(`${submitted.out}\n${submitted.err}`, /INFRA_NOTE_REQUIRED/u);
});

test('a gate named by a quoted path or a shell separator needs a note [C7,V4]', (t) => {
  // Each gate names a script the change then edits: a quoted path with a space, and a path followed by a separator.
  // An unnormalized path names the same file Git reports, so it needs the note too (#814 review).
  for (const [gate, file] of [["node 'src/check gate.js'", 'src/check gate.js'], ['node src/check.js; true', 'src/check.js'],
    ['node src/../src/check.js', 'src/check.js'], ['node ./src/./check.js', 'src/check.js']]) {
    let box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate, spec: 'SPEC.md' }));
    put(box.root, file, 'process.exit(0);\n');
    commitAll(box);
    box = builderRepo(box);
    assert.equal(box.coordinator('add', 'build', 'Gate named by a path', '--check', 'true').code, 0);
    assert.equal(box.run('claim', '1').code, 0);
    put(box.root, file, 'process.exit(0); // edited after the claim\n');
    commitAll(box, 'feat(core): change the gate script [G1]');
    const refused = box.run('submit', '1');
    const output = `${refused.out}\n${refused.err}`;
    assert.equal(refused.code, 1, `${gate}: the edit is refused without a note\n${output}`);
    assert.match(output, /INFRA_NOTE_REQUIRED/u, `${gate}: the refusal is INFRA_NOTE_REQUIRED`);
    assert.ok(output.includes(file), `${gate}: the refusal names ${file}`);
  }
});
