/**
 * The shared fixture for the submit infra-note journeys: a private repository, a joined builder, and a submit that waits
 * for its pulled gate [C7,V4].
 *
 * Why shared: the journeys are split across files so each stays under the per-file budget, since every settled submit
 * waits on a real pulled gate job.
 */
import { runFixtureGit } from '../child.js';
import { settleSubmit } from './settle.js';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import assert from 'node:assert/strict';
import { runCliInProcess } from '../process.js';
import { waitForCondition } from '../runner/holders.js';

const BIN = join(import.meta.dirname, '../../../pullboard.js');
const SPEC = '# Submit proof fixture\n\n## G · Goals\n- G1 [approved, must] The selected test proves the change. | gate: test\n';

/** Finish only this fixture's detached observations before the active case ends and cleanup removes its board. */
export async function drainComparisons(box, t) {
  const directory = join(box.dir, 'repo/.git/pullboard/review-comparisons');
  const jobs = existsSync(directory) ? readdirSync(directory).map(job => join(directory, job)) : [];
  await waitForCondition(() => jobs.every(job => existsSync(join(job, 'result.json'))),
    'owned submit-infra comparison to finish', { signal: t.signal });
}

/**
 * Submit item 1 and wait for its pulled gate: the receipt records the submit and its infra note, which show then reads [C7].
 */
export async function submitSettled(t, box, ...extra) {
  const submitted = await box.run('submit', '1', ...extra, '--json');
  if (submitted.code === 0) await settleSubmit(t, { repo: box.root, env: box.env, run: (_cwd, ...args) => box.run(...args) }, JSON.parse(submitted.out));
  return submitted;
}

/** Write a fixture file, creating its parent directory when needed. */
export function put(root, path, text) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Commit the fixture state using a valid Pullboard message. */
export function commitAll(box, message = 'chore: fixture state') {
  box.git('add', '-A');
  box.git('commit', '-q', '-m', message);
  return box.git('rev-parse', 'HEAD');
}

/** Create a private Git repository with a deterministic identity and isolated Pullboard home. */
export async function privateRepo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-submit-infra-')));
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
    PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: join(dir, 'home'),
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
export async function builderRepo(box, { requireInfraNote = true, extraOwns = [] } = {}) {
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
export async function infraBox(t, { edit, existing = true, requireInfraNote = true, files = ['test/existing.test.js'] }) {
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

/**
 * One gate named by a path or shell separator, whose script the change then edits, must receive a drafted infra note.
 * Why here: the four gate spellings are split across two journey files under the per-file budget [C7,V4].
 */
export async function draftedNoteCase(t, gate, file) {
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
  const submitted = await submitSettled(t, box);
  assert.equal(submitted.code, 0, `${gate}: ${submitted.out}\n${submitted.err}`);
  const shown = await box.run('show', '1');
  assert.match(shown.out, /infra note:/u);
  assert.ok(shown.out.includes(file), `${gate}: the note names ${file}`);
  await drainComparisons(box, t);
}
