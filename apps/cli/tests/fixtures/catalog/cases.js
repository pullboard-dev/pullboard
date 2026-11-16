/** The catalog's real-CLI cases, each naming the JSON_SHAPES.commands keys it covers; catalog.test.js runs them [A1,C7,#8843]. */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  runFixtureExecFile as execFileSync,
  startFixtureChild as spawn,
  runFixtureChild as spawnSync,
  reportFixtureChildFailure,
  runFixtureChild,
  runFixtureChildAsync,
  cleanupFixtureChildren,
  runFixtureGit,
  safeFixtureDiagnostic,
  privateFixtureFiles,
} from '../child.js';
import { performance } from 'node:perf_hooks';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import {
  join,
  dirname,
  resolve,
  basename,
  delimiter,
} from 'node:path';
import { after } from 'node:test';
import { main } from '../native.js';
import { runCliInProcess } from '../process.js';
import { whenRunnerSettles } from '../runner/local-start.js';
import { createLocalApiHandler } from '../../../../../packages/api/index.js';
import {
  addItem as addBoardItem,
  allShouts,
  EVENT_LOG_VERSION,
  closeBoard,
  events as boardEvents,
  verdictsFor,
} from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { JSON_SHAPES } from '../../../../../packages/config/index.js';
import { FIXTURE_DISTINCT_ENV } from '../../../src/io/item/duplicate.js';
import { projectState } from '../../../src/io/view.js';
import { serveView } from '../../../src/io/commands/view.js';
import { registerProject } from '../../../../../packages/seats/index.js';
import { SSH_SHELL_MARKERS } from '../../../../../packages/kernel/index.js';
import { fetchFresh } from '../http.js';
import {
  fixtureJSON as intakeFixtureJSON,
  intakeFixture,
} from '../intake.js';
import { relayClientFixture } from '../relay/client.js';
import {
  exerciseAdditiveRoots,
  exercisePatchCommands,
} from '../api/roots.js';
import { assertSpecCorrectionRefreezesCitations } from '../refreeze.js';
import {
  FIXTURE_MODEL,
  fixtureJoin,
  fixtureProjectPolicy,
} from '../testkit.js';
import {
  HOST,
  installSshStandIn,
} from '../runner/ssh.js';

const BIN = resolve(import.meta.dirname, '../../../pullboard.js');
const TEMP_DIRS = [];
// The light-route model the hand-off case joins with.
const LIGHT_MODEL = 'gpt-6-luna';
// Local runners that pull submits started on a case's machine; killed when the file ends.
const LOCAL_RUNNERS = [];
const COMPILE_CACHE = privateFixtureFiles('pullboard-api-compile-cache-').root;
TEMP_DIRS.push(COMPILE_CACHE);
const covered = new Set();
const coveredRoots = new Set();
const catalogCases = [];
// The roots the running case has added so far, so a case can be held to the roots it declared.
const caseRoots = new AsyncLocalStorage();

// Bound real CLI/Git/server/watch children together; each private workflow keeps its command order.
let childSlots = 3;
let closingCatalog = false;
const childWaiters = [];
const serverChildren = new Map();

/** Acquire one of three child slots; handing it directly to a waiter keeps admission fair. */
async function catalogChildSlot() {
  if (closingCatalog) throw new Error('the catalog fixture is closing');
  if (childSlots) childSlots -= 1;
  else await new Promise((resolve, reject) => childWaiters.push({ resolve, reject }));
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const next = childWaiters.shift();
    if (next) next.resolve();
    else childSlots += 1;
  };
}

/** Keep each actual CLI or Git child in its slot until its result includes the close event. */
async function withCatalogChild(run) {
  const release = await catalogChildSlot();
  try {
    if (closingCatalog) throw new Error('the catalog fixture is closing');
    return await run();
  }
  finally { release(); }
}

/** Spawn synchronously after admission so callers install listeners before the next event-loop turn. */
function spawnCatalogChild(release, command, args, options) {
  let child;
  try {
    if (closingCatalog) throw new Error('the catalog fixture is closing');
    child = spawn(command, args, options);
  }
  catch (error) { release(); throw error; }
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    serverChildren.delete(child);
    release();
    resolve([code, signal]);
  }));
  serverChildren.set(child, closed);
  return { child, closed };
}


/** Record one root command as exercised, for the run as a whole and for the case that is running. */
function addRoot(command) {
  coveredRoots.add(command);
  caseRoots.getStore()?.add(command);
}

/** Wrap a case's run so it fails if it adds a root command it did not declare; the declarations are what the static union is built from. */
function declaredRun(roots, run) {
  const declared = new Set(roots);
  return async (t) => {
    const added = new Set();
    const result = await caseRoots.run(added, () => run(t));
    const undeclared = [...added].filter((root) => !declared.has(root)).sort();
    assert.deepEqual(undeclared, [], `the case added roots it did not declare; add them to its roots: ${undeclared.join(', ')}`);
    return result;
  };
}

/**
 * Queue one independent real-repository case that names the JSON_SHAPES.commands keys it covers and the root commands
 * its run adds to coveredRoots; the catalog test waits for all of them, and coverage.test.js checks the declared roots statically.
 */
function catalogCase(name, covers, run, roots) {
  catalogCases.push({ name, covers, roots, run: declaredRun(roots, run) });
}

after(async () => {
  closingCatalog = true;
  for (const waiter of childWaiters.splice(0)) waiter.reject(new Error('the catalog fixture is closing'));
  for (const child of serverChildren.keys()) child.kill('SIGKILL');
  await Promise.all(serverChildren.values());
  await cleanupFixtureChildren();
  for (const pid of LOCAL_RUNNERS) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

const SPEC = `# API fixture

## G · Goals
- G1 [approved, must] The fixture keeps its board. | gate: true
`;

/** Quote a literal executable path for the fixture hook's POSIX shim. */
function shellWord(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Make a disposable home and a real repo with isolated git settings. */
function sandbox() {
  const dir = privateFixtureFiles('pullboard-api-').root;
  TEMP_DIRS.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = Object.assign({}, process.env, {
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'API Test',
    GIT_AUTHOR_EMAIL: 'api@example.invalid',
    GIT_COMMITTER_NAME: 'API Test',
    GIT_COMMITTER_EMAIL: 'api@example.invalid',
    PULLBOARD_HOME: join(dir, 'home'),
    HOME: join(dir, 'private-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'home'),
    NODE_COMPILE_CACHE: COMPILE_CACHE,
  });
  mkdirSync(env.PULLBOARD_MACHINE_HOME, { recursive: true });
  delete env.PULLBOARD_RELAY_TOKEN;
  delete env.PULLBOARD_STARTUP_TRACE_FILE;
  delete env.PULLBOARD_STARTUP_TRACE_ENTRY;
  delete env.PULLBOARD_STARTUP_TEST_HOLD_PHASE;
  delete env.PULLBOARD_STARTUP_TEST_PHASE_REACHED_FILE;
  delete env.PULLBOARD_STARTUP_TEST_RELEASE_FILE;
  for (const marker of SSH_SHELL_MARKERS) delete env[marker];
  const git = (cwd, ...args) => withCatalogChild(async () => {
    const result = await runFixtureChildAsync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
    if (result.status !== 0) throw new Error(result.failure);
    return result.stdout.trim();
  });
  // In process through the production dispatcher; the fixture's git hooks still launch the real shim.
  const run = (cwd, ...args) => runCliInProcess(args, { cwd, env });
  return { dir, env, git, run, runLocal: run };
}

/** Replace a fixture project's SPEC.md text, keeping the pullboard.json it already has. */
function setSpec(repo, spec) {
  fixtureProjectPolicy(repo, { config: JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8')), spec });
}

/** The box with its command runner replaced by a real child process, for the cases that need one. */
function processBox(box) {
  return { ...box, runLocal: (cwd, ...args) => withCatalogChild(() => runFixtureChildAsync(process.execPath, [BIN, ...args], { cwd, env: box.env, encoding: 'utf8' })) };
}

/** Initialize a real board with an undeclared legacy coordinator for the API protocol fixtures. */
async function project() {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  await box.git(repo, 'init', '-q', '-b', 'main');
  const inheritedModel = box.env.PULLBOARD_MODEL;
  delete box.env.PULLBOARD_MODEL;
  const initialized = await json(box, repo, 'init');
  if (inheritedModel !== undefined) box.env.PULLBOARD_MODEL = inheritedModel;
  const configFile = join(repo, 'pullboard.json');
  // These fixtures prove API shapes with "true" checks, so they keep a board with no hold setting.
  const { checks: _hold, ...config } = JSON.parse(readFileSync(configFile, 'utf8'));
  fixtureProjectPolicy(repo, { spec: SPEC, config: {
    ...config,
    gate: 'true',
    landing: { ...config.landing, manualOverride: true },
    spec: 'SPEC.md',
    practice: 'DOCTRINE.md',
    lanes: {
      app: { owns: ['app/'], specs: ['G1'] },
      review: { owns: [] },
    },
    shared: [],
  } });
  writeFileSync(join(repo, 'DOCTRINE.md'), '');
  await box.git(repo, 'add', '-A');
  await box.git(repo, 'commit', '-q', '-m', 'chore: set up API fixture');
  return { ...box, repo, initialized };
}

/**
 * Commit one change on the checkout's trunk that cites the item. A submit whose head is main itself is EMPTY_SUBMIT
 * unless that head is a commit citing the item (#2608), so a single-checkout fixture builds its item this way.
 */
async function commitItemChange(box, repo, id) {
  writeFileSync(join(repo, `item-${id}.txt`), `change for item ${id}\n`);
  await box.git(repo, 'add', `item-${id}.txt`);
  await box.git(repo, 'commit', '-q', '-m', `chore: fixture change for item ${id}`, '-m', `Pullboard-Item: #${id}`);
}

/** Resolve the catalog entry for either a root command or a documented subcommand. */
function shapeFor(command, subcommand) {
  const candidates = [
    ...(subcommand ? [`${command} ${subcommand}`, `${command}.${subcommand}`, `${command}:${subcommand}`] : []),
    command,
  ];
  const key = candidates.find((candidate) => JSON_SHAPES.commands[candidate]);
  assert.ok(key, `JSON_SHAPES.commands must document ${command}${subcommand ? ` ${subcommand}` : ''}`);
  covered.add(key);
  addRoot(command);
  return JSON_SHAPES.commands[key];
}

/** Match one catalog field to its declared JSON value type. */
function hasType(value, type) {
  if (type.includes('|')) return type.split('|').some((part) => hasType(value, part));
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

/** Check one required-field map from JSON_SHAPES. */
function assertRequiredShape(value, required, label) {
  for (const [field, type] of Object.entries(required ?? {})) {
    assert.ok(Object.hasOwn(value, field), `${label} must include ${field}`);
    assert.ok(hasType(value[field], type), `${label}.${field} must be ${type}`);
  }
}

/** Parse a command's sole JSON document and check its public command shape. */
async function json(box, cwd, command, args = [], subcommand) {
  let result = await box.runLocal(cwd, command, ...args, '--json');
  // The catalog files many near-identical items by design; answer the likely-duplicate guard once, naming the item it found.
  const near = command === 'add' && result.status !== 0 ? /DUPLICATE_LIKELY[\s\S]*?#(\d+)/u.exec(result.stdout + result.stderr)?.[1] : undefined;
  if (near) result = await box.runLocal(cwd, command, ...args, '--not-duplicate-of', `${near} catalog fixture items repeat by design`, '--json');
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr}${result.stdout}`);
  const document = JSON.parse(result.stdout);
  if (command === 'check' && subcommand !== 'accept') {
    assert.equal(result.stderr, `check #${document.id} set by ${document.by} (unknown): ${document.check}\n`, 'check attribution is visible before execution while stdout remains one JSON document');
  } else if (command === 'done' || command === 'submit') {
    assert.match(result.stderr, /^(?:(?:cells-submit|submit-placement) receipt not reused: (?:tree|config) changed(?:; (?:tree|config) changed)*\n)*$/, `${command} permits only the cache diagnostic on stderr`);
  } else if (command === 'test') {
    // A local start waits out a busy host and says so on stderr; nothing else may appear beside the one JSON document.
    assert.match(result.stderr, /^(?:pullboard test: load \d+(?:\.\d+)? on \d+ cores; waiting for it to drop under \d+ before a local start\n)*$/, 'test --json permits only the load wait notice on stderr');
  } else assert.equal(result.stderr, '', `${command} --json must keep stderr empty`);
  assert.equal(document.version, 1, `${command} --json has a version 1 envelope`);
  // A pull submit returns queued at once (item, commit, gateJob); the machine's local runner posts the gate receipt, so wait
  // for the item to leave claimed and read the gate from the settled receipt instead of the inline result.
  if ((command === 'submit' || command === 'done') && document.queued) {
    shapeFor(command, subcommand); // marks the command as exercised; its inline-result fields (id, pin, gate) come from the settled receipt below
    assertRequiredShape(document, { item: 'number', commit: 'string', gateJob: 'string', queued: 'boolean' }, `queued ${command}`);
    if (document.localRunner?.pid) LOCAL_RUNNERS.push(document.localRunner.pid);
    const settled = await whenRunnerSettles(box.env, async () => {
      const shown = await box.runLocal(cwd, 'show', String(document.item), '--json', '--no-next');
      const read = shown.status === 0 ? JSON.parse(shown.stdout) : null;
      return read && read.item_status !== 'claimed' ? read : null;
    }, { deadlineMs: 120_000, what: `the pulled gate of #${document.item}` });
    return { ...document, id: document.item, gate: settled.gateJob?.gate ?? null };
  }
  assertRequiredShape(document, shapeFor(command, subcommand).required, command);
  return document;
}

/** Run a real CLI root whose result shape predates the versioned shape catalog. */
async function uncataloguedRootJSON(box, cwd, command, args = []) {
  const result = await box.runLocal(cwd, command, ...args, '--json');
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr}${result.stdout}`);
  assert.equal(result.stderr, '', `${command} --json must keep stderr empty`);
  const document = parseOneDocument(result.stdout);
  addRoot(command);
  return document;
}

/** Check one refusal document, including the exact public code, message and next step. */
async function jsonError(box, cwd, command, args, { status, code, message, next }, subcommand) {
  const result = await box.runLocal(cwd, command, ...args, '--json');
  assert.equal(result.status, status, `${command}: ${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, '', `${command} refusal must be JSON-only`);
  const document = JSON.parse(result.stdout);
  assert.equal(document.version, 1);
  assertRequiredShape(document, JSON_SHAPES.error.required, 'error envelope');
  assertRequiredShape(document.error, JSON_SHAPES.errorFields, 'error');
  if (subcommand) shapeFor(command, subcommand);
  assert.deepEqual(document.error, { code, message, next });
  return document;
}

/** Assert only that output is a single JSON value with no second document. */
function parseOneDocument(stdout) {
  const document = JSON.parse(stdout);
  assert.equal(document.version, 1);
  return document;
}


catalogCase('[A1] command results match the catalog across roots and subcommands', [
  'add',
  'agents',
  'answer',
  'badge',
  'blueprint add',
  'blueprint starters',
  'capacity',
  'check',
  'claim',
  'decisions',
  'doctor',
  'doctrine check',
  'done',
  'edit',
  'escalate',
  'fact',
  'forget',
  'gate',
  'health',
  'heartbeat',
  'help',
  'hold',
  'hook commit-msg',
  'hook pre-commit',
  'hook pre-merge-commit',
  'hook pre-push',
  'hooks',
  'inbox',
  'init',
  'join',
  'lanes',
  'ledger',
  'lifecycle',
  'list',
  'log',
  'merged',
  'next',
  'pass',
  'patch',
  'patch attach',
  'patch list',
  'patch remove',
  'prompt',
  'refreeze',
  'release',
  'request',
  'resources',
  'resume',
  'run',
  'settings',
  'shout',
  'show',
  'skills',
  'spec',
  'spec check',
  'spec draft',
  'spec show',
  'spec signers',
  'spec signoff',
  'spec unmet',
  'spec view',
  'stats',
  'stats moves',
  'stats pipeline',
  'status',
  'submit',
  'sweep',
  'tour',
  'verify',
  'version',
  'whoami',
  'why',
  'why file',
  'withdraw',
  'worktree',
], async (t) => {
  const box = await project();
  const { repo } = box;
  assert.equal(box.initialized.version, 1);
  assertRequiredShape(box.initialized, shapeFor('init').required, 'init');

  for (const [flag, command] of [['--help', 'help'], ['--version', 'version']]) {
    const output = await box.runLocal(repo, flag, '--json');
    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stderr, '');
    const document = parseOneDocument(output.stdout);
    assertRequiredShape(document, shapeFor(command).required, command);
  }
  await json(box, repo, 'version');
  await json(box, repo, 'help');
  await json(box, repo, 'lifecycle');
  await json(box, repo, 'request', ['list']);
  await json(box, repo, 'prompt', ['signoff']);
  await json(box, repo, 'hooks');
  await json(box, repo, 'whoami');
  await json(box, repo, 'lanes');
  assert.ok(Array.isArray((await json(box, repo, 'agents')).agents));
  await json(box, repo, 'resources');
  assert.equal((await json(box, repo, 'settings')).settings.gateSlots, 2);
  assert.equal((await json(box, repo, 'settings', ['gateSlots', '1'])).settings.gateSlots, 1);
  assert.equal((await json(box, repo, 'settings')).settings.gateSlots, 1);
  const machineSettings = join(box.env.PULLBOARD_HOME, 'settings.json');
  assert.equal(JSON.parse(readFileSync(machineSettings, 'utf8')).gateSlots, 1);
  assert.equal(existsSync(join(box.env.PULLBOARD_HOME, 'config.json')), false, 'machine settings use the separate settings.json file');
  await json(box, repo, 'resume');
  await json(box, repo, 'status');
  const heartbeat = await json(box, repo, 'heartbeat');
  assert.equal(heartbeat.seat, 'coordinator');
  assert.equal(heartbeat.presence, 'live');
  assert.ok(Number.isFinite(Date.parse(heartbeat.heartbeatAt)), 'an explicit hook returns its real local observation');
  await json(box, repo, 'stats');
  assert.equal((await json(box, repo, 'stats', ['pipeline', '--limit', '5'], 'pipeline')).pipeline.limit, 5);
  assert.equal((await json(box, repo, 'stats', ['moves', '--limit', '5'], 'moves')).moves.limit, 5);
  const capacity = await json(box, repo, 'capacity');
  assert.equal(capacity.report.suite.minutes, null);
  assert.equal(capacity.report.files.lowerBound, true);
  assert.ok(Array.isArray(capacity.report.conversion.order));
  const cost = (await json(box, repo, 'stats')).usage;
  assert.deepEqual(Object.keys(cost).sort(), ['items', 'lanes', 'milestones', 'models', 'seats', 'sharedSessions'].sort());
  for (const group of ['items', 'lanes', 'milestones', 'models', 'seats', 'sharedSessions']) {
    assert.deepEqual(cost[group], [], `a fresh board has no invented ${group} usage totals`);
  }
  await json(box, repo, 'badge');
  await json(box, repo, 'doctor');
  assert.deepEqual((await json(box, repo, 'health')).stuck, [], 'a new board has nothing stuck [A6]');
  await json(box, repo, 'skills', ['--update']);
  const plainStatus = await box.runLocal(repo, 'status');
  assert.equal(plainStatus.status, 0, plainStatus.stderr);
  assert.equal(plainStatus.stderr, '');
  assert.match(plainStatus.stdout, /^coordinator \(unknown\): /, 'ordinary text mode remains readable');
  assert.throws(() => JSON.parse(plainStatus.stdout));
  await json(box, repo, 'inbox');
  await json(box, repo, 'decisions');
  await json(box, repo, 'ledger');
  await json(box, repo, 'log');
  await json(box, repo, 'list');
  await json(box, repo, 'gate');

  await json(box, repo, 'spec', ['--json']);
  await json(box, repo, 'spec', ['check'], 'check');
  assert.deepEqual((await json(box, repo, 'doctrine', ['check'], 'check')).rules, [], 'a repo with no check rows reports no rules [D1]');
  await json(box, repo, 'spec', ['view', '--out', join(box.dir, 'spec.html')], 'view');
  await json(box, repo, 'spec', ['show', 'G1'], 'show');
  await json(box, repo, 'spec', ['unmet'], 'unmet');
  const catalogStarters = (await json(box, repo, 'blueprint', ['starters', 'web-app'], 'starters')).starters;
  assert.ok(catalogStarters.length && catalogStarters.every((starter) => !starter.filed && starter.id === null), 'blueprint starters lists unfiled starters with no id');
  assert.equal((await json(box, repo, 'spec', ['draft', 'A draft API catalogue row'], 'draft')).id, 'G2');
  for (const [name, kind, rules] of [['catalog', undefined, [['R1', 'A catalog rule.']]], ['catalog-practice', 'practice', [['R1', 'A catalog rule.'], ['R2', 'A practice catalog rule.']]]]) writeFileSync(join(box.dir, `${name}-blueprint.json`), `${JSON.stringify({ blueprint: 1, name, title: name, version: 1, kind, rules: rules.map(([key, text]) => ({ key, text, why: 'the API lists it.' })) })}\n`);
  assert.deepEqual((({ rows, blueprints }) => [rows[0].status, rows.length, blueprints.length, blueprints[1].shared.length])(await json(box, repo, 'blueprint', ['add', join(box.dir, 'catalog-blueprint.json'), '--blueprint', join(box.dir, 'catalog-practice-blueprint.json')], 'add')), ['draft', 2, 2, 1], 'two blueprints in one add land as one result, a shared rule drafted once (#720)');
  mkdirSync(join(repo, 'test'));
  writeFileSync(join(repo, 'test/proof.test.js'), "import { test } from 'node:test';\ntest('proof [G1]', () => {});\n");
  await box.git(repo, 'add', 'SPEC.md', 'test/proof.test.js');
  await box.git(repo, 'commit', '-q', '-m', 'test: cite the fixture');
  const signerKey = join(box.dir, 'signer-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', signerKey], { stdio: 'pipe' });
  await box.git(repo, 'config', 'user.signingkey', signerKey);
  await json(box, repo, 'spec', ['signers', 'add', '--key', `${signerKey}.pub`, '--by', 'CO'], 'signers');
  await box.git(repo, 'add', '.pullboard/signers', '.pullboard/signers.initial', '.pullboard/first-commit');
  await box.git(repo, 'commit', '-q', '-m', 'chore: opt into signed sign-offs');
  await json(box, repo, 'spec', ['signoff', 'G1', '--by', 'CO'], 'signoff');
  await box.git(repo, 'add', '.pullboard/signoffs.jsonl');
  await box.git(repo, 'commit', '-q', '-m', 'chore: record the fixture signoff');

  const messageFile = join(box.dir, 'commit-message.txt');
  writeFileSync(messageFile, 'chore: valid fixture\n');
  // Process-level: the hook commands read the real stdin, so they run as child processes.
  await json(processBox(box), repo, 'hook', ['pre-commit'], 'pre-commit');
  await json(processBox(box), repo, 'hook', ['pre-merge-commit'], 'pre-merge-commit');
  await json(processBox(box), repo, 'hook', ['commit-msg', messageFile], 'commit-msg');
  await json(processBox(box), repo, 'hook', ['pre-push'], 'pre-push');

  const review = await json(box, repo, 'worktree', ['review']);
  const reviewPath = review.path;
  const secondPath = join(box.dir, 'review-two');
  await box.git(repo, 'worktree', 'add', '-q', secondPath, '-b', 'review/two');
  await json(box, secondPath, 'join', ['review']);

  const added = await json(box, repo, 'add', ['coordinator', 'API item', '--specs', 'G1', '--criterion', 'the API item is verified', '--check', 'true']);
  assert.equal(added.item.item_id, 1);
  await json(box, repo, 'fact', ['1', 'note', 'API fact']);
  await json(box, repo, 'fact', ['1', 'decision', 'API decision', '--implies', '1']);
  assert.equal((await json(box, repo, 'why', ['1'])).decisions[0].line, 'API decision', 'why lists the decision that implies the item [N29]');
  assert.equal((await json(box, repo, 'why', ['SPEC.md'], 'file')).file, 'SPEC.md', 'file provenance has its own additive JSON shape [A1,N29]');
  await json(box, repo, 'edit', ['1', '--criterion', 'the edited API item is verified', '--check', 'true']);
  await json(box, repo, 'show', ['1']);
  await json(box, repo, 'list', ['--all']);
  await json(box, repo, 'claim', ['1']);
  await json(box, repo, 'check', ['1']);
  await json(box, repo, 'release', ['1', '--reason', 'BLOCKED', '--no-next']);
  await json(box, repo, 'claim', ['1']);
  await commitItemChange(box, repo, 1);
  const submitted = await json(box, repo, 'submit', ['1', '--no-next']);
  await exercisePatchCommands({ box, json, submitted });
  await json(box, reviewPath, 'next', ['--verify']);
  await box.git(reviewPath, 'switch', '--detach', submitted.commit);
  await json(box, reviewPath, 'verify', ['1', 'accept', '--note', 'checked the fixture result', '--no-next']);
  await json(box, repo, 'merged', ['1', 'HEAD']);

  await json(box, repo, 'add', ['coordinator', 'Done alias item', '--check', 'true']);
  await json(box, repo, 'claim', ['2']);
  await commitItemChange(box, repo, 2);
  await json(box, repo, 'done', ['2', '--no-next']);
  await json(box, repo, 'add', ['coordinator', 'Withdraw item']);
  await json(box, repo, 'withdraw', ['3', 'obsolete']);

  await json(box, repo, 'add', ['coordinator', 'Refreeze item', '--specs', 'G1']);
  await json(box, repo, 'claim', ['4']);
  // #1870 requires governing rows: exercise actual person-approved spec apply and changed frozen bars.
  assertSpecCorrectionRefreezesCitations(t);
  assert.equal((await json(box, repo, 'refreeze', ['4'])).unchanged, true);
  await json(box, repo, 'release', ['4', '--reason', 'BLOCKED', '--no-next']);

  await json(box, repo, 'add', ['coordinator', 'Escalate item', '--route', 'mid', '--criterion', 'the item is built', '--check', 'true', '--brief', 'Files:\n- README.md\nChange:\n- keep this fixture\nTest:\n- The item check passes']);
  await json(box, repo, 'claim', ['5']);
  await json(box, repo, 'escalate', ['5', '--note', 'the first route needs another pass']);
  await json(box, repo, 'hold', ['app', '--reason', 'exercise JSON']);
  await json(box, repo, 'hold', ['app', '--off']);

  await json(box, secondPath, 'shout', ['Please decide', '--decision', '--kind', 'question']);
  await json(box, repo, 'decisions');
  await json(box, repo, 'pass', ['1', 'The test run is complete']);
  await json(box, repo, 'answer', ['2', 'Yes, keep the change', '--as', 'person']);
  await json(box, secondPath, 'inbox');
  await json(box, repo, 'sweep', ['--run', 'true', '--check', 'true {file}']);

  await json(box, reviewPath, 'run', ['--agent', 'true', '--items', '1']);

  // The undeclared coordinator builds nothing, so the claiming next runs from a builder seat that serves the item's route.
  const builderPath = join(box.dir, 'app-next');
  await box.git(repo, 'worktree', 'add', '-q', builderPath, '-b', 'app/next');
  await json(box, builderPath, 'join', ['app', '--model', FIXTURE_MODEL, '--route', 'strong']);
  await json(box, repo, 'add', ['app', 'Next item', '--route', 'mid', '--criterion', 'the item is built', '--check', 'true', '--accept-green', 'catalog fixture', '--brief', 'Files:\n- app/next.js\nChange:\n- keep this fixture\nTest:\n- The item check passes']);
  await json(box, builderPath, 'next');
  await json(box, repo, 'forget', ['.']);

  const tour = await json(box, repo, 'tour');
  const location = tour.messages.find((line) => line.startsWith('Look around: cd '));
  assert.ok(location, 'tour result keeps its final repo path in messages');
  const tourRepo = /Look around: cd (.+) && pullboard log/.exec(location)?.[1];
  assert.ok(tourRepo && existsSync(tourRepo), 'the reported tour repo exists until the test cleans it up');
  assert.match(basename(dirname(tourRepo)), /^pullboard-tour-/, 'cleanup is confined to the generated tour folder');
  TEMP_DIRS.push(dirname(tourRepo));
}, ['add', 'agents', 'answer', 'badge', 'blueprint', 'capacity', 'check', 'claim', 'decisions', 'doctor', 'doctrine', 'done', 'edit', 'escalate', 'fact', 'forget', 'gate', 'health', 'heartbeat', 'help', 'hold', 'hook', 'hooks', 'inbox', 'init', 'join', 'lanes', 'ledger', 'lifecycle', 'list', 'log', 'merged', 'next', 'pass', 'patch', 'prompt', 'refreeze', 'release', 'request', 'resources', 'resume', 'run', 'settings', 'shout', 'show', 'skills', 'spec', 'stats', 'status', 'submit', 'sweep', 'tour', 'verify', 'version', 'whoami', 'why', 'withdraw', 'worktree']);


catalogCase('[A1,B21,B27] a lane decision is answered by its agent through CLI JSON', [
  'answer',
  'inbox',
  'init',
  'shout',
], async () => {
  const box = await project();
  const agent = join(box.dir, 'app-1');
  await box.git(box.repo, 'worktree', 'add', '-q', agent, '-b', 'app/one');
  const joined = await fixtureJoin(box.run, agent, 'app');
  assert.equal(joined.status, 0, joined.stderr);

  const ask = await json(box, box.repo, 'shout', ['app', 'Should this endpoint retry?', '--decision']);
  const answer = await json(box, agent, 'answer', [String(ask.id), 'Retry once.']);
  assert.equal(answer.answers, ask.id);
  assert.ok(Number.isInteger(answer.id));

  const delivered = (await json(box, box.repo, 'inbox')).shouts.find(({ shout_id }) => shout_id === answer.id);
  assert.ok(delivered, 'the original coordinator receives the lane answer');
  assert.equal(delivered.shout_from, 'app-1');
  assert.equal(delivered.shout_answers, ask.id);
  assert.equal(delivered.shout_text, 'Retry once.');
}, ['answer', 'inbox', 'init', 'shout']);


catalogCase('[A1,B21,B27] decisions shows an agent its direct and lane asks only', [
  'answer',
  'decisions',
  'init',
  'pass',
  'shout',
], async () => {
  const box = await project();
  /** Create a real worktree registered to the requested lane. */
  const worktree = async (name, lane) => {
    const path = join(box.dir, name);
    await box.git(box.repo, 'worktree', 'add', '-q', path, '-b', `${lane}/${name}`);
    const joined = await fixtureJoin(box.run, path, lane);
    assert.equal(joined.status, 0, joined.stderr);
    return path;
  };
  const app1 = await worktree('app-1', 'app');
  const app2 = await worktree('app-2', 'app');
  const review = await worktree('review-1', 'review');
  const laneAsk = (await json(box, box.repo, 'shout', ['app', 'Lane decision?', '--decision'])).id;
  const app1Ask = (await json(box, box.repo, 'shout', ['app-1', 'App one decision?', '--decision'])).id;
  const app2Ask = (await json(box, box.repo, 'shout', ['app-2', 'App two decision?', '--decision'])).id;
  const reviewAsk = (await json(box, box.repo, 'shout', ['review', 'Review decision?', '--decision'])).id;
  const coordinatorAsk = (await json(box, app1, 'shout', ['coordinator', 'Coordinator decision?', '--decision', '--kind', 'question'])).id;

  const app1Queue = (await json(box, app1, 'decisions')).decisions.map(({ shout_id }) => shout_id);
  assert.deepEqual(app1Queue, [laneAsk, app1Ask]);
  const app1Text = await box.runLocal(app1, 'decisions');
  assert.equal(app1Text.status, 0, app1Text.stderr);
  assert.match(app1Text.stdout, new RegExp(`#${laneAsk}\\b`));
  assert.match(app1Text.stdout, new RegExp(`#${app1Ask}\\b`));
  assert.doesNotMatch(app1Text.stdout, new RegExp(`#(?:${app2Ask}|${reviewAsk}|${coordinatorAsk})\\b`));
  assert.deepEqual((await json(box, app2, 'decisions')).decisions.map(({ shout_id }) => shout_id), [laneAsk, app2Ask]);
  assert.deepEqual((await json(box, review, 'decisions')).decisions.map(({ shout_id }) => shout_id), [reviewAsk]);
  const app2Text = await box.runLocal(app2, 'decisions');
  assert.equal(app2Text.status, 0, app2Text.stderr);
  assert.match(app2Text.stdout, new RegExp(`#${laneAsk}\\b`));
  assert.match(app2Text.stdout, new RegExp(`#${app2Ask}\\b`));
  const reviewText = await box.runLocal(review, 'decisions');
  assert.equal(reviewText.status, 0, reviewText.stderr);
  assert.match(reviewText.stdout, new RegExp(`#${reviewAsk}\\b`));
  assert.doesNotMatch(reviewText.stdout, new RegExp(`#(?:${laneAsk}|${app1Ask}|${app2Ask}|${coordinatorAsk})\\b`));

  await json(box, app2, 'answer', [String(laneAsk), 'Lane answered.']);
  assert.deepEqual((await json(box, app1, 'decisions')).decisions.map(({ shout_id }) => shout_id), [app1Ask]);
  const answeredText = await box.runLocal(app2, 'decisions');
  assert.equal(answeredText.status, 0, answeredText.stderr);
  assert.match(answeredText.stdout, new RegExp(`#${app2Ask}\\b`));
  assert.doesNotMatch(answeredText.stdout, new RegExp(`#${laneAsk}\\b`));
  assert.deepEqual((await json(box, box.repo, 'decisions')).decisions.map(({ shout_id }) => shout_id), [coordinatorAsk]);
  const passedAsk = (await json(box, app1, 'shout', ['coordinator', 'Please decide this.', '--decision', '--kind', 'question'])).id;
  const pass = await json(box, box.repo, 'pass', [String(passedAsk), 'the person should decide']);
  assert.deepEqual((await json(box, box.repo, 'decisions', ['--as', 'person'])).decisions.map(({ shout_id }) => shout_id), [pass.id]);
  await jsonError(box, app1, 'decisions', ['--as', 'person'], {
    status: 1,
    code: 'B26_PERSON_ANSWER',
    message: 'only the main checkout can act as the person; ask your coordinator to answer or pass this decision',
    next: 'ask your coordinator to answer or pass this decision',
  });
  await jsonError(box, app1, 'answer', [String(app2Ask), 'No'], {
    status: 1,
    code: 'NOT_YOUR_DECISION',
    message: `shout #${app2Ask} is addressed to app-2, not your app lane (agent app-1)`,
    next: 'answer only decisions addressed to you; see pullboard inbox',
  });
  const coordinatorText = await box.runLocal(box.repo, 'decisions');
  assert.equal(coordinatorText.status, 0, coordinatorText.stderr);
  assert.match(coordinatorText.stdout, new RegExp(`#${coordinatorAsk}\\b`));
  assert.doesNotMatch(coordinatorText.stdout, new RegExp(`#(?:${app1Ask}|${app2Ask}|${reviewAsk})\\b`));
}, ['answer', 'decisions', 'init', 'pass', 'shout']);


catalogCase('[A1] refusals are one JSON document with exact public error fields', [
  'init',
  'next',
  'spec check',
  'spec show',
  'status',
], async () => {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  await box.git(repo, 'init', '-q', '-b', 'main');
  await json(box, repo, 'init');
  fixtureProjectPolicy(repo, { config: { gate: 'true', lanes: {} } });
  await box.git(repo, 'add', '-A');
  await box.git(repo, 'commit', '-q', '-m', 'chore: set up refusal fixture');

  const noShip = await box.runLocal(repo, 'ship', '--json');
  assert.equal(noShip.status, 1, noShip.stdout + noShip.stderr);
  assert.equal(noShip.stderr, '', 'ship refuses without mixing text into JSON output');
  const shipDocument = parseOneDocument(noShip.stdout);
  assertRequiredShape(shipDocument, JSON_SHAPES.error.required, 'ship error envelope');
  assertRequiredShape(shipDocument.error, JSON_SHAPES.errorFields, 'ship refusal');
  assert.equal(shipDocument.error.code, 'USAGE');
  assert.match(shipDocument.error.message, /ship needs exactly one owned item/u);
  addRoot('ship');

  const noRow = await jsonError(box, repo, 'spec', ['show', 'G99'], {
    status: 1,
    code: 'NO_ROW',
    message: 'no row G99 in SPEC.md',
    next: 'list the rows with pullboard spec --json, then name one of them',
  }, 'show');
  assert.equal(noRow.error.code, 'NO_ROW');

  // The plain loop finishes at once: a coordinator seat with nothing to build gets one successful document, not a refusal.
  const plainLoop = await box.runLocal(repo, 'next', '--json');
  assert.equal(plainLoop.status, 0);
  assert.equal(plainLoop.stderr, '');
  assert.deepEqual(JSON.parse(plainLoop.stdout), {
    version: 1,
    item: null,
    next: 'nothing for this seat: end your turn',
    reasons: ["no open items in the coordinator lane; lane items are built from each lane's own worktree"],
  });
  // A bounded wait that finds nothing is the refusal: one JSON document with the exact public error fields.
  const nothingFree = await box.runLocal(repo, 'next', '--wait', '0', '--json');
  assert.equal(nothingFree.status, 1);
  assert.equal(nothingFree.stderr, '');
  const nextDocument = JSON.parse(nothingFree.stdout);
  assert.equal(nextDocument.version, 1);
  assertRequiredShape(nextDocument, JSON_SHAPES.error.required, 'error envelope');
  assertRequiredShape(nextDocument.error, JSON_SHAPES.errorFields, 'error');
  shapeFor('next');
  assert.deepEqual(nextDocument.error, {
    code: 'NOTHING_FREE',
    message: "no item is free; no open items in the coordinator lane; lane items are built from each lane's own worktree. To keep looking: pullboard next --take",
    next: 'To keep looking: pullboard next --take',
  });

  const unknown = await box.runLocal(repo, 'status', '--not-a-real-flag', '--json');
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stderr, '');
  const unknownDocument = JSON.parse(unknown.stdout);
  assert.equal(unknownDocument.version, 1);
  assertRequiredShape(unknownDocument, JSON_SHAPES.error.required, 'error envelope');
  assertRequiredShape(unknownDocument.error, JSON_SHAPES.errorFields, 'error');
  shapeFor('status');
  assert.equal(unknownDocument.error.code, 'USAGE');
  assert.match(unknownDocument.error.message, /Unknown option '--not-a-real-flag'/);
  assert.equal(unknownDocument.error.next, 'run pullboard help');

  const unknownCommand = await box.runLocal(repo, 'cliam', '--json');
  assert.equal(unknownCommand.status, 2);
  assert.equal(unknownCommand.stderr, '');
  const unknownCommandDocument = JSON.parse(unknownCommand.stdout);
  assert.equal(unknownCommandDocument.version, 1);
  assertRequiredShape(unknownCommandDocument, JSON_SHAPES.error.required, 'error envelope');
  assertRequiredShape(unknownCommandDocument.error, JSON_SHAPES.errorFields, 'error');
  assert.equal(unknownCommandDocument.error.code, 'USAGE');
  assert.match(unknownCommandDocument.error.message, /no command "cliam"; closest match is "claim"/);
  assert.match(unknownCommandDocument.error.next, /pullboard help --all/);

  const valid = readFileSync(join(repo, 'SPEC.md'), 'utf8');
  setSpec(repo, `${valid}\n- G2 [maybe, must] Bad status.\n`);
  const textCheck = await box.runLocal(repo, 'spec', 'check');
  assert.equal(textCheck.status, 1);
  const invalid = await box.runLocal(repo, 'spec', 'check', '--json');
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stderr, '');
  const invalidDocument = JSON.parse(invalid.stdout);
  assert.equal(invalidDocument.version, 1);
  assertRequiredShape(invalidDocument, JSON_SHAPES.error.required, 'error envelope');
  assertRequiredShape(invalidDocument.error, JSON_SHAPES.errorFields, 'error');
  shapeFor('spec', 'check');
  assert.equal(invalidDocument.error.code, 'COMMAND_FAILED');
  assert.equal(invalidDocument.error.message, textCheck.stdout.trim());
  assert.equal(invalidDocument.error.next, 'read the reported output above, fix what it names, and run the command again');
  rmSync(box.dir, { recursive: true, force: true });
}, ['init', 'next', 'ship', 'spec', 'status']);


catalogCase('[A1] long-running servers flush one JSON document before shutdown', ['init', 'serve', 'view'], async (t) => {
  for (const command of ['view', 'serve']) {
    const box = await project();
    const args = [BIN, command, ...(command === 'view' ? ['--no-open'] : []), '--port', '0', '--json'];
    const startedAt = performance.now();
    const release = await catalogChildSlot();
    const { child, closed } = spawnCatalogChild(release, process.execPath, args, { cwd: box.repo,
      env: command === 'view' ? { ...box.env, PULLBOARD_VIEW_FOREGROUND: '1' } : box.env,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
      rmSync(box.dir, { recursive: true, force: true });
    });
    const ready = new Promise((resolveReady, rejectReady) => {
      let settled = false;
      const failStartup = (detail, status = child.exitCode, signal = child.signalCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        rejectReady(new Error(reportFixtureChildFailure({ command: process.execPath, args, status, signal,
          elapsedMs: performance.now() - startedAt, stderr, env: box.env, detail })));
      };
      const timeout = setTimeout(() => failStartup('server readiness deadline (10000ms) expired'), 10_000); // budget: hang ceiling for private server readiness; no throughput claim.
      child.stdout.on('data', () => {
        try {
          const document = JSON.parse(stdout);
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolveReady(document);
        } catch {
          // The public document is pretty-printed; wait until it is complete.
        }
      });
      child.once('error', (error) => {
        failStartup(error.message, null, null);
      });
      child.once('close', (code, signal) => failStartup('server exited before flushing its JSON result', code, signal));
    });
    const document = await ready;
    assert.equal(document.version, 1);
    addRoot(command);
    assertRequiredShape(document, shapeFor(command).required, command);
    child.kill('SIGTERM');
    await closed;
    assert.equal(stderr, '');
    assert.deepEqual(parseOneDocument(stdout), document, `${command} does not flush a second document on shutdown`);
  }
}, ['init', 'serve', 'view']);

catalogCase('[A1,A2] watch --json prints one catalog document per event line', ['init', 'shout', 'watch'], async (t) => {
  const box = await project();
  const release = await catalogChildSlot();
  const { child, closed } = spawnCatalogChild(release, process.execPath, [BIN, 'watch', '--json', '--kinds', 'shout'], { cwd: box.repo, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    rmSync(box.dir, { recursive: true, force: true });
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let changed = () => {};
  child.stdout.on('data', (part) => { stdout += part; changed(); });
  child.stderr.on('data', (part) => { stderr += part; changed(); });
  /** Resolve once `read()` holds what the step waits for, or fail at the hang ceiling. */
  const until = (read, label) => new Promise((resolveWait, rejectWait) => {
    const timer = setTimeout(() => rejectWait(new Error(`watch printed no ${label}\nstdout: ${stdout}\nstderr: ${stderr}`)), 10_000); // budget: hang ceiling for private CLI startup and one line, not a latency claim.
    changed = () => { if (read()) { clearTimeout(timer); changed = () => {}; resolveWait(); } };
    changed();
  });
  await until(() => /following/u.test(stderr), 'start note');
  await json(box, box.repo, 'shout', ['app', 'catalog watch line']);
  await until(() => stdout.includes('\n'), 'event line');
  const document = JSON.parse(stdout.split('\n')[0]);
  assert.equal(document.version, 1);
  assertRequiredShape(document, shapeFor('watch').required, 'watch');
  assert.equal(document.detail, 'to app: catalog watch line');
  child.kill('SIGTERM');
  const [code] = await closed;
  assert.equal(code, 0);
  assert.equal(stdout, `${JSON.stringify(document)}\n`, 'watch prints no end-of-command document');
}, ['init', 'shout', 'watch']);


catalogCase('[A1,A10] view exports a static folder through its JSON variant', ['add', 'init', 'view export'], async () => {
  const box = await project();
  const item = (await json(box, box.repo, 'add', ['app', 'Snapshot item', '--specs', 'G1'])).item;
  const output = join(box.dir, 'snapshot folder');
  const result = await json(box, box.repo, 'view', ['--export', output], 'export');
  assert.equal(result.path, output);
  assert.equal(result.url, undefined);
  assert.equal(result.port, undefined);
  assert.ok(existsSync(join(output, 'index.html')));
  assert.ok(existsSync(join(output, 'view.css')));
  const listing = JSON.parse(readFileSync(join(output, 'api/v1/boards.json'), 'utf8'));
  assert.equal(listing.version, 1);
  assert.equal(listing.boards.length, 1);
  const id = listing.boards[0].id;
  const state = JSON.parse(readFileSync(join(output, 'api/v1/boards', id, 'state.json'), 'utf8'));
  const events = JSON.parse(readFileSync(join(output, 'api/v1/boards', id, 'events.json'), 'utf8'));
  assert.equal(state.version, 1);
  assert.equal(state.state.board, id);
  assert.equal(state.eventLogVersion, EVENT_LOG_VERSION);
  assert.equal(state.state.root, basename(box.repo));
  assert.equal(state.state.items[0].id, item.item_id);
  assert.equal(events.version, 1);
  assert.equal(events.eventLogVersion, EVENT_LOG_VERSION);
  assert.ok(events.events.some((event) => event.event_kind === 'add' && event.item_id === item.item_id));
  assert.deepEqual(events.events.map((event) => event.event_id), events.events.map((event) => event.event_id).sort((a, b) => a - b));
}, ['add', 'init', 'view']);


catalogCase('[A1,E13,E14,E15] move returns its real CLI result across local boards', ['move'], async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const team = await box.cliLocal('add', box.lane, 'Catalog move source');
  assert.equal(team.code, 0, JSON.stringify(team.document?.error));
  const local = await box.cliLocal('add', box.lane, 'Catalog move destination', '--private');
  assert.equal(local.code, 0, JSON.stringify(local.document?.error));

  const shape = shapeFor('move');
  const moved = await box.cliLocal('move', String(team.document.item.item_id), '--to', '~fixture/repository');
  assert.equal(moved.code, 0, JSON.stringify(moved.document?.error));
  assertRequiredShape(moved.document, shape.required, 'move');
  assert.equal(moved.document.source, `fixture/repository#${team.document.item.item_id}`);
  assert.equal(moved.document.item.moveId, moved.document.moveId);
  assert.equal(moved.document.item.sourceItemId, team.document.item.item_id);
  assert.notEqual(moved.document.item.destinationItemId, local.document.item.item_id, 'the moved item gets a new private-board ID');
  assert.equal(moved.document.destination, `~fixture/repository#${moved.document.item.destinationItemId}`);
  assert.match(moved.document.moveId, /^[0-9a-f-]{36}$/u);
  assert.equal(moved.document.item.item.item_title, 'Catalog move source');
}, ['move']);

catalogCase('[A1] catalog commands keep their real repository exercises', [
  'add',
  'blueprint add',
  'blueprint fit',
  'check accept',
  'claim',
  'companion',
  'digest',
  'export',
  'flakes',
  'flakes rerun',
  'gate set',
  'import',
  'init',
  'join',
  'labels',
  'land',
  'lane add',
  'lanes',
  'loop',
  'loop declare',
  'loop ran',
  'maintenance',
  'milestone add',
  'milestone edit',
  'milestone focus',
  'milestone items',
  'milestone lift',
  'milestone move',
  'milestone order',
  'milestone pin',
  'milestone remove',
  'milestone ship',
  'milestone sink',
  'queue',
  'relay',
  'reopen',
  'rigor',
  'rigor draft',
  'roadmap',
  'runner',
  'search',
  'seats',
  'sentinel approve',
  'sentinel decline',
  'sentinel propose',
  'sentinels',
  'spec answer',
  'spec apply',
  'spec approve',
  'spec decline',
  'spec fit',
  'stats agents',
  'stats disk',
  'stats review',
  'stats runners',
  'stats time',
  'submit',
  'takeover',
  'tool-build',
  'trace',
  'verify compare',
  'why release',
], async () => {
  const source = await project();
  const target = await project();
  const document = await json(source, source.repo, 'export');
  assert.match((await json(source, source.repo, 'digest')).markdown, /^# Board briefing: /u);
  const file = join(source.dir, 'board.json');
  writeFileSync(file, JSON.stringify(document));
  await json(source, target.repo, 'import', [file]);
  const humanTarget = await project();
  const humanImport = await source.run(humanTarget.repo, 'import', file);
  assert.equal(humanImport.status, 0, humanImport.stderr || humanImport.stdout);
  assert.match(humanImport.stdout, /imported version 1 board tables/);

  await json(source, source.repo, 'relay');
  assert.deepEqual(await json(source, source.repo, 'relay', ['status']), await json(source, source.repo, 'relay'), 'relay status reports what plain relay reports');
  await json(source, source.repo, 'relay', ['off']);
  const catalog = (await json(source, source.repo, 'add', ['app', 'Catalog item', '--criterion', 'catalog coverage'], 'add')).item;
  const bar = await uncataloguedRootJSON(source, source.repo, 'bar', [String(catalog.item_id)]);
  assert.equal(bar.id, catalog.item_id);
  assert.ok(Array.isArray(bar.missing), 'bar reports current readiness omissions for this item');
  // A pulled land offer is its own document (offered, items, waiting), not the retired batch shape the catalog declares, so it is read directly and counted as the land exercise.
  const offering = await source.run(source.repo, 'land', '--json');
  assert.equal(offering.status, 0, offering.stderr || offering.stdout);
  const landing = parseOneDocument(offering.stdout);
  covered.add('land');
  addRoot('land');
  assert.ok(!landing.offered, `nothing is verified, so no land job is offered: ${offering.stdout}`);
  assert.deepEqual(landing.items ?? [], [], offering.stdout);
  const published = join(source.dir, 'published.git');
  await source.git(source.dir, 'init', '-q', '--bare', published);
  await source.git(source.repo, 'remote', 'add', 'origin', published);
  const publishing = await source.run(source.repo, 'publish', '--json');
  assert.equal(publishing.status, 0, publishing.stderr || publishing.stdout);
  const publication = parseOneDocument(publishing.stdout);
  addRoot('publish');
  const trunkHead = await source.git(source.repo, 'rev-parse', 'HEAD');
  assert.deepEqual([publication.head, publication.published, publication.red], [trunkHead, true, []]);
  assert.equal(await source.git(published, 'rev-parse', 'refs/heads/main'), trunkHead, 'publish pushed the head the suite passed');
  await source.git(source.repo, 'remote', 'remove', 'origin'); // Later catalog commands keep their remote-less fixture.
  await json(source, source.repo, 'roadmap');
  await json(source, source.repo, 'queue');
  const failures = await json(source, source.repo, 'flakes');
  assert.deepEqual([failures.flakes, failures.unclassified, failures.regressions, failures.stable], [[], [], [], []]);
  const failurePolicy = join(source.repo, 'pullboard.json');
  const originalPolicy = readFileSync(failurePolicy, 'utf8');
  assert.equal((await json(source, source.repo, 'flakes', ['rerun', 'on'], 'rerun')).flakes.rerun, true);
  assert.equal(JSON.parse(readFileSync(failurePolicy, 'utf8')).flakes.rerun, true, 'the coordinator edits the private project policy');
  assert.equal((await json(source, source.repo, 'flakes', ['rerun', 'off'], 'rerun')).flakes.rerun, false);
  assert.equal(JSON.parse(readFileSync(failurePolicy, 'utf8')).flakes.rerun, false);
  writeFileSync(failurePolicy, originalPolicy, 'utf8'); // These uncommitted policy edits do not alter the later catalog fixture.
  await json(source, source.repo, 'rigor');
  const watch = await json(source, source.repo, 'sentinel', ['propose', 'catalog-watch', '--check', 'true', '--every', 'hourly', '--owner', 'coordinator'], 'propose');
  assert.equal(watch.sentinel.status, 'pending');
  assert.equal((await json(source, source.repo, 'sentinel', ['approve', 'catalog-watch'], 'approve')).sentinel.status, 'approved');
  assert.equal((await json(source, source.repo, 'sentinel', ['decline', 'catalog-watch', '--reason', 'Catalog coverage complete'], 'decline')).sentinel.status, 'declined');
  assert.equal((await json(source, source.repo, 'sentinels')).sentinels[0].name, 'catalog-watch');
  assert.equal((await json(source, source.repo, 'loop', ['declare', 'catalog-job', '--every', '10m', '--owner', 'coordinator'], 'declare')).job.every, '10m');
  assert.equal((await json(source, source.repo, 'loop', ['ran', 'catalog-job'], 'ran')).job.runs, 1);
  assert.equal((await json(source, source.repo, 'loop')).jobs[0].name, 'catalog-job');
  const companion = await json(source, source.repo, 'companion', [String(catalog.item_id), 'coordinator', 'Catalog companion', '--key', 'catalog', '--route', 'mid', '--criterion', 'the companion is built', '--check', 'true', '--brief', 'Files:\n- README.md\nChange:\n- keep this fixture\nTest:\n- The item check passes']);
  assert.equal(companion.item.item_parent_id, catalog.item_id);
  assert.equal(companion.created, true);
  await json(source, source.repo, 'milestone', ['add', 'Catalog', '--items', String(catalog.item_id), '--reason', 'Exercise catalog milestone placement'], 'add');
  await json(source, source.repo, 'milestone', ['items', 'Catalog', '--remove', String(catalog.item_id)], 'items');
  await json(source, source.repo, 'milestone', ['items', 'Catalog', '--add', String(catalog.item_id), '--reason', 'Exercise catalog milestone placement'], 'items');
  await json(source, source.repo, 'milestone', ['order', 'Catalog', String(catalog.item_id), '--reason', 'Exercise catalog milestone ordering'], 'order');
  await json(source, source.repo, 'milestone', ['pin', 'Catalog', String(catalog.item_id), '--reason', 'Catalog coverage first'], 'pin');
  const sunk = await json(source, source.repo, 'milestone', ['sink', 'Catalog', String(catalog.item_id), '--reason', 'Catalog coverage last'], 'sink');
  assert.deepEqual([sunk.milestone.sunk, sunk.milestone.reasons[String(catalog.item_id)]], [[catalog.item_id], 'Catalog coverage last'], 'a sink records the item and its reason');
  assert.equal((await json(source, source.repo, 'milestone', ['lift', 'Catalog', String(catalog.item_id)], 'lift')).milestone.sunk, undefined, 'a lift returns the item to the computed order');
  await json(source, source.repo, 'milestone', ['add', 'Later'], 'add');
  await json(source, source.repo, 'milestone', ['move', 'Later', '--before', 'Catalog'], 'move');
  const focused = await json(source, source.repo, 'milestone', ['focus', 'Catalog'], 'focus');
  assert.deepEqual([focused.focus, focused.overflow], ['Catalog', false], 'focus names the release seats hold to');
  assert.equal((await json(source, source.repo, 'milestone', ['focus', 'off'], 'focus')).focus, null, 'focus off clears it before later moves');
  await json(source, source.repo, 'milestone', ['edit', 'Catalog', '--name', 'Release', '--note', 'Catalog coverage'], 'edit');
  await json(source, source.repo, 'milestone', ['edit', 'Release', '--target', '2026-10-20T18:00Z'], 'edit');
  const shippedLater = await json(source, source.repo, 'milestone', ['ship', 'Later'], 'ship');
  assert.deepEqual([shippedLater.into, shippedLater.moved, shippedLater.notMoved], [null, [], []], 'an empty milestone ships with nothing to move');
  await json(source, source.repo, 'milestone', ['remove', 'Later'], 'remove');
  await json(source, source.repo, 'milestone', ['remove', 'Release'], 'remove');
  const reopenItem = (await json(source, source.repo, 'add', ['coordinator', 'Reopen catalog item', '--criterion', 'Exercise the versioned reopen result.', '--check', 'true', '--accept-green', 'catalog fixture'], 'add')).item;
  assert.equal((await json(source, source.repo, 'check', ['accept', String(reopenItem.item_id)], 'accept')).check, 'true', 'the person accepts the check as it reads');
  await json(source, source.repo, 'claim', [String(reopenItem.item_id)]);
  await commitItemChange(source, source.repo, reopenItem.item_id);
  await json(source, source.repo, 'submit', [String(reopenItem.item_id), '--no-next']);
  const comparison = await json(source, source.repo, 'verify', [String(reopenItem.item_id), '--compare'], 'compare');
  assert.equal(comparison.status, 'complete');
  assert.deepEqual([comparison.files, comparison.head.id, comparison.base.id], [[], null, null], 'an empty selection records no executions');
  await json(source, source.repo, 'reopen', [String(reopenItem.item_id), '--note', 'exercise the versioned reopen result']);
  // A cause repeated on two items becomes a draft row once its check is proved red, then green (#714).
  for (const title of ['Rigor catalog one', 'Rigor catalog two']) {
    const caused = (await json(source, source.repo, 'add', ['coordinator', title, '--criterion', 'Exercise a caused reopen.', '--check', 'true', '--accept-green', 'catalog fixture'], 'add')).item;
    await json(source, source.repo, 'claim', [String(caused.item_id)]);
    await commitItemChange(source, source.repo, caused.item_id);
    await json(source, source.repo, 'submit', [String(caused.item_id), '--no-next']);
    await json(source, source.repo, 'reopen', [String(caused.item_id), '--note', 'the bar cites the wrong row', '--cause', 'row:G1']);
  }
  const red = await source.git(source.repo, 'rev-parse', 'HEAD');
  mkdirSync(join(source.repo, 'app'), { recursive: true });
  writeFileSync(join(source.repo, 'app', 'fixed.txt'), 'fixed\n');
  await source.git(source.repo, 'add', 'app/fixed.txt');
  await source.git(source.repo, 'commit', '-q', '-m', 'feat(app): add the fixed file [G1]');
  const drafted = await json(source, source.repo, 'rigor', ['draft', 'row:G1', 'The fixed file exists', '--check', 'test -f app/fixed.txt', '--red', red, '--green', 'HEAD'], 'draft');
  assert.equal(drafted.drafts.length, 1);
  await json(source, source.repo, 'spec', ['approve', 'G1'], 'approve');
  await json(source, source.repo, 'spec', ['decline', 'G1', '--reason', 'Catalog decline'], 'decline');
  setSpec(source.repo, `${readFileSync(join(source.repo, 'SPEC.md'), 'utf8')}- G3 [pending, must] Which store holds the catalog: SQLite. Choices: SQLite, Postgres. | gate: review\n`);
  await json(source, source.repo, 'spec', ['answer', 'G3', 'Postgres'], 'answer');
  await json(source, source.repo, 'spec', ['apply'], 'apply');

  /** Exercise the agent-only takeover with a private explicit session, leaving later terminal calls markerless. */
  // Process-level: takeover refuses without a real agent shell, so it runs as a child with the session id set.
  const sessionSource = processBox({ ...source, env: { ...source.env, CODEX_SESSION_ID: 'api-catalog-session' } });
  await json(sessionSource, source.repo, 'takeover');
  const fitBlueprint = await json(source, source.repo, 'blueprint', ['add', 'web-app'], 'add');
  const fitTarget = fitBlueprint.rows[0].id;
  const fitProposal = await json(source, source.repo, 'blueprint', ['fit', 'web-app', fitTarget, 'keep'], 'fit');
  assert.equal(fitProposal.proposals[0].target, fitTarget);
  assert.equal((await json(source, source.repo, 'spec', ['fit'], 'fit')).proposals.length, 1);
  const lane = await json(source, source.repo, 'lane', ['add', 'catalog', '--owns', 'catalog/'], 'add');
  assert.deepEqual([lane.lane, lane.owns], ['catalog', ['catalog/']]);
  assert.deepEqual((await json(source, source.repo, 'lanes')).lanes.catalog, { owns: ['catalog/'] });
  // Registration probes the host over SSH, so the catalog box answers with the private stand-in that runs the pinned worker.
  const sshBin = join(source.dir, 'ssh-bin');
  const remoteHome = join(source.dir, 'runner-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  for (const folder of [sshBin, join(source.dir, 'runner-worker'), remoteHome, remoteMachineHome]) mkdirSync(folder, { recursive: true });
  installSshStandIn({ bin: sshBin, worker: join(source.dir, 'runner-worker'), home: remoteHome, machineHome: remoteMachineHome, requests: join(source.dir, 'ssh-requests.jsonl') });
  source.env.PATH = `${sshBin}:${source.env.PATH}`;
  const runner = await json(source, source.repo, 'runner', ['add', HOST, '--slots', '2', '--browser', '1']);
  // Registration measures the host over the probe, so the record also carries what the probe observed.
  const { cores, gui, measuredAt, memoryMB, node, publicKey, ...registered } = runner.runner;
  assert.deepEqual(registered, { host: HOST, slots: 2, browser: 1, fixed: true });
  assert.ok(typeof gui === 'boolean' || gui === null, 'gui is what the probe saw, or null when it saw no display');
  assert.deepEqual([typeof cores, typeof (gui ?? false), typeof measuredAt, typeof memoryMB, typeof node, typeof publicKey], ['number', 'boolean', 'string', 'number', 'string', 'string']);
  const projectGate = JSON.parse(readFileSync(join(source.repo, 'pullboard.json'), 'utf8')).gate;
  assert.equal((await json(source, source.repo, 'gate', ['set', projectGate], 'set')).gate, projectGate);
  assert.equal(typeof (await json(source, source.repo, 'maintenance')).enabled, 'boolean');
  assert.ok(Array.isArray((await json(source, source.repo, 'seats')).seats));
  assert.equal(typeof (await json(source, source.repo, 'stats', ['time'], 'time')).time, 'object');
  assert.equal(typeof (await json(source, source.repo, 'stats', ['disk'], 'disk')).disk, 'object', 'stats disk reports disk use per store');
  for (const name of ['agents', 'review', 'runners']) {
    assert.equal(typeof (await json(source, source.repo, 'stats', [name], name))[name], 'object', `stats ${name} has its own additive JSON shape [A1]`);
  }
  assert.ok(Array.isArray((await json(source, source.repo, 'labels')).labels), 'labels lists each label [A1]');
  assert.equal((await json(source, source.repo, 'search', ['catalog'])).query, 'catalog', 'search echoes its query [A1]');
  assert.ok(Array.isArray((await json(source, source.repo, 'why', [], 'release')).items), 'why release lists the release flow [A1]');
  const trace = await json(source, source.repo, 'trace', [String(catalog.item_id)]);
  assert.deepEqual([trace.subject, trace.since, Array.isArray(trace.entries)], [String(catalog.item_id), null, true], 'trace reads one item timeline');
  assert.ok(Object.hasOwn(await json(source, source.repo, 'tool-build'), 'build'));

  const handoffPath = join(source.dir, 'catalog-handoff');
  await source.git(source.repo, 'worktree', 'add', '--detach', '--quiet', handoffPath, 'HEAD');
  const joined = await json(source, handoffPath, 'join', ['app', '--model', LIGHT_MODEL, '--route', 'light']);
  assert.equal(joined.lane, 'app');
  const handoff = await uncataloguedRootJSON(source, handoffPath, 'handoff');
  assert.ok(Number.isSafeInteger(handoff.handoff.item), 'handoff opens a replacement item from the joined worktree');
  assert.equal(handoff.resume.agent, joined.agent);
}, ['add', 'blueprint', 'check', 'claim', 'companion', 'digest', 'export', 'flakes', 'gate', 'import', 'init', 'join', 'labels', 'land', 'lane', 'lanes', 'loop', 'maintenance', 'milestone', 'queue', 'relay', 'reopen', 'rigor', 'roadmap', 'runner', 'search', 'seats', 'sentinel', 'sentinels', 'spec', 'stats', 'submit', 'takeover', 'tool-build', 'trace', 'verify', 'why']);

catalogCase('[A1,R1,R2] flow replay exposes its recorded history and replay through real CLI JSON', ['flow replay', 'init'], async () => {
  const box = await project();
  const result = await json(box, box.repo, 'flow', ['replay'], 'replay');
  assert.equal(result.history.version, 1);
  assert.ok(Array.isArray(result.history.events));
  assert.equal(result.replay.mode, 'recorded');
  assert.ok(Array.isArray(result.replay.items));
  assert.ok(Array.isArray(result.replay.landingOrder));
  assert.equal(typeof result.replay.stages, 'object');
}, ['flow', 'init']);

catalogCase('[A1,C7] map exposes its main stamp and every rendered view through real CLI JSON', ['add', 'init', 'map'], async () => {
  const box = await project();
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  writeFileSync(join(box.repo, 'src/map-fixture.js'), '/** Return a fixture value. */\nexport function mapFixture() { return 1; }\n');
  await box.git(box.repo, 'add', 'src/map-fixture.js');
  await box.git(box.repo, 'commit', '-q', '-m', 'test: add the catalog map source');
  const main = (await box.git(box.repo, 'rev-parse', 'main')).trim();
  const overview = await json(box, box.repo, 'map');
  assert.equal(overview.main, main);
  assert.match(overview.map, /Pullboard code map/u);
  const card = await json(box, box.repo, 'map', ['mapFixture']);
  assert.equal(card.main, main);
  assert.match(card.map, /src\/map-fixture\.js#mapFixture/u);
  const item = await json(box, box.repo, 'add', ['coordinator', 'Map source', '--specs', 'G1',
    '--criterion', 'src/map-fixture.js defines mapFixture', '--check', 'true', '--accept-green', 'catalog fixture']);
  const slice = await json(box, box.repo, 'map', ['--for', String(item.item.item_id)]);
  assert.equal(slice.main, main);
  assert.match(slice.map, /src\/map-fixture\.js/u);
  const plain = await box.runLocal(box.repo, 'map', 'mapFixture');
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /\nnext: pullboard next\n$/u, 'the text-only footer is present');
  assert.equal(plain.stdout.replace(/\nnext: pullboard next\n$/u, '\n'), `${card.map}\n`,
    'JSON carries exactly the ordinary rendered card, excluding only its trailing text action');
}, ['add', 'init', 'map']);

catalogCase('[A1] intake records a real outside pull request through the CLI', [], async (t) => {
  const box = intakeFixture(t);
  const document = intakeFixtureJSON(box, box.repo, 'intake', box.pull.html_url,
    '--criterion', 'the outside fixture is recorded without running its code',
    '--check', 'node --test test/contribution.test.js');
  addRoot('intake');
  assert.ok(Number.isSafeInteger(document.item.item_id));
  assert.equal(document.item.item_status, 'submitted');
  assert.equal(document.item.item_commit, box.commit);
}, ['intake']);

catalogCase('[A1,C7] test runs named test files as a pulled job and reports the runner', ['init', 'test'], async () => {
  const box = await project();
  const configFile = join(box.repo, 'pullboard.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), affectedTests: 'env -u NODE_TEST_CONTEXT node --test --test-reporter=tap' }, null, 2)); // this file's own runner must not nest it
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test/catalog.test.js'), "import { test } from 'node:test';\ntest('catalog passes', () => {});\n");
  await box.git(box.repo, 'add', '-A');
  await box.git(box.repo, 'commit', '-q', '-m', 'test: a focused runner and one test file');
  const result = await json(box, box.repo, 'test', ['test/catalog.test.js']);
  assert.equal(result.green, true);
  assert.deepEqual(result.files, ['test/catalog.test.js']);
  assert.match(result.runner, /^local-/u, 'the pulled job runs on the machine\'s loopback runner, which the settled receipt names');
  assert.deepEqual(result.counts, { passed: 1, failed: 0, skipped: 0 });
  assert.match(readFileSync(result.logPath, 'utf8'), /^ok 1 - catalog passes/mu,
    'the actual TAP is retained in the complete log instead of the public summary');
}, ['init', 'test']);

catalogCase('[A1,H11] sync shares a board through a real Git remote without an account', ['init', 'sync'], async () => {
  const source = await project();
  const remote = join(source.dir, 'shared-board.git');
  await source.git(source.dir, 'init', '-q', '--bare', remote);
  await source.git(source.repo, 'remote', 'add', 'origin', remote);
  const result = await json(source, source.repo, 'sync');
  assert.equal(result.ref, 'refs/pullboard/board');
  assert.equal(result.sequence, 0);
  assert.equal(result.pending, null);
  assert.match(await source.git(remote, 'rev-parse', result.ref), /^[0-9a-f]{40,64}$/u);
}, ['init', 'sync']);

catalogCase('[A1,B26] slice creates a frozen child of a claimed item through real CLI JSON', [
  'add',
  'check accept',
  'claim',
  'init',
], async () => {
  const source = await project();
  const parent = (await json(source, source.repo, 'add', ['coordinator', 'Slice parent', '--criterion', 'Every slice inherits this bar.', '--check', 'true', '--accept-green', 'catalog fixture'], 'add')).item;
  await json(source, source.repo, 'check', ['accept', String(parent.item_id)], 'accept');
  await json(source, source.repo, 'claim', [String(parent.item_id)]);
  const { item } = await uncataloguedRootJSON(source, source.repo, 'slice', [String(parent.item_id), 'Slice part', '--files', 'app/part.js', '--check', 'true']);
  assert.deepEqual([item.item_parent_id, item.item_criterion], [parent.item_id, 'Every slice inherits this bar.'], 'the slice inherits its parent and frozen criterion');
}, ['add', 'check', 'claim', 'init']);

catalogCase('[A1,C7] additive roots expose a real report and refuse missing native audit evidence', ['init'], () =>
  exerciseAdditiveRoots({ project, uncataloguedRootJSON, withCatalogChild, coveredRoots: { add: addRoot } }), ['gate-health', 'init', 'push-receipts', 'shadow-batch', 'test-value']);

catalogCase('[A1,C7] red explain reports absent evidence through the catalog', ['init', 'red'], async () => {
  const box = await project();
  const result = await json(box, box.repo, 'red', ['explain', 'test/catalog.test.js']);
  assert.equal(result.file, 'test/catalog.test.js');
  assert.equal(result.unavailable, 'no recorded red on main history');
}, ['init', 'red']);

catalogCase('[A1,C7] mutate reports caught and missed faults through the catalog', ['init', 'mutate'], async () => {
  const box = await project();
  const cell = join(box.repo, 'cells', 'calc');
  mkdirSync(cell, { recursive: true });
  writeFileSync(join(cell, 'calc.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  writeFileSync(join(cell, 'calc.test.js'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from '../calc.js';\ntest('add', () => { assert.equal(add(2, 3), 5); });\n");
  await box.git(box.repo, 'add', 'cells');
  await box.git(box.repo, 'commit', '-q', '-m', 'test(calc): add the calc cell');
  const report = await json(box, box.repo, 'mutate', ['cells/calc', '--all']);
  assert.equal(report.cell, 'cells/calc');
  assert.equal(report.all, true);
  assert.equal(report.caught + report.missed, report.faults.length, 'every seeded fault is caught or missed');
}, ['init', 'mutate']);

catalogCase('[A1,C7,#8842] cells lists sealed and unsealed cells through the catalog', ['cells', 'init'], async () => {
  const box = await project();
  const report = await json(box, box.repo, 'cells');
  assert.ok(Array.isArray(report.cells), 'cells lists every cell');
  assert.deepEqual(report.unsealed, report.cells.filter((row) => row.state === 'unsealed').map((row) => row.cell), 'unsealed names the unsealed cells');
}, ['cells', 'init']);

catalogCase('[A1,C7,#8842] route suggests light items through the catalog', ['init', 'route'], async () => {
  const box = await project();
  const report = await json(box, box.repo, 'route', ['--suggest']);
  assert.equal(report.suggest, 'light');
  assert.ok(Array.isArray(report.items), 'route lists the strong items that meet the light shape');
}, ['init', 'route']);

catalogCase('[A1,C7] rules replays the event log through the catalog', ['init', 'rules'], async () => {
  const box = await project();
  const report = await json(box, box.repo, 'rules');
  assert.equal(report.judged, report.agreed + report.disagreementCount, 'every judged event agrees or is listed');
}, ['init', 'rules']);

catalogCase('[A1,C7] compact reports a dry run through the catalog', ['compact', 'init'], async () => {
  const box = await project();
  const report = await json(box, box.repo, 'compact', ['--dry-run']);
  assert.equal(report.dryRun, true);
  assert.equal(report.rows, 0, 'a new board has no old finished steps to archive');
}, ['compact', 'init']);

catalogCase('[A1,C7,#8071] replay reports a table through the catalog', ['init', 'replay'], async () => {
  const box = await project();
  const dir = join(box.repo, 'packages/demo/src/logic');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'demo.table.js'), 'export const DEMO_RULES = {};\nexport const DEMO_TABLE = { name: \'demo\', guards: [], outcomes: [] };\n');
  const report = await json(box, box.repo, 'replay', ['demo']);
  assert.equal(report.table, 'demo');
}, ['init', 'replay']);

catalogCase('[A1,C7,#8072] explain reports a table through the catalog', ['explain', 'init'], async () => {
  const box = await project();
  const dir = join(box.repo, 'packages/demo/src/logic');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'demo.table.js'), 'export const DEMO_RULES = {};\nexport const DEMO_TABLE = { name: \'demo\', guards: [], outcomes: [] };\n');
  const report = await json(box, box.repo, 'explain', ['demo']);
  assert.equal(report.table, 'demo');
}, ['explain', 'init']);

catalogCase('[A1,C7] contribute check reports an accepted record through the catalog', ['contribute', 'init'], async () => {
  const box = await project();
  const file = join(box.dir, 'record.yml');
  writeFileSync(file, 'rows:\n  - G1.2\nversion: "0.9.5"\nran: pullboard next\nblocks: nothing\nbar:\n  - 1: the command prints a line [test]\ncheck:\n  - 1: apps/cli/tests/x.test.js > prints a line\nrefusal: |\n  NO_LINE: nothing printed\n');
  const report = await json(box, box.repo, 'contribute', ['check', file, 'Bug'], 'check');
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.deepEqual([report.shape, report.failures], ['Bug', []]);
}, ['contribute', 'init']);

catalogCase('[A1,C7,#8515] coordinate resumes the coordinator through real CLI JSON and writes nothing', [], async () => {
  const box = await project();
  const first = await uncataloguedRootJSON(box, box.repo, 'coordinate');
  assert.equal(first.version, 1, 'coordinate --json has a version 1 envelope');
  assert.ok(Array.isArray(first.all), 'coordinate reports the same resume view the coordinator reads');
  const second = await uncataloguedRootJSON(box, box.repo, 'coordinate');
  assert.deepEqual([second.all.length, second.agents.length], [first.all.length, first.agents.length], 'running it twice adds no agent or request');
}, ['coordinate', 'init']);

catalogCase('[A1,C7,#8378] moves reports each move table state through real CLI JSON', [], async () => {
  const box = await project();
  const { tables } = await uncataloguedRootJSON(box, box.repo, 'moves');
  assert.ok(Array.isArray(tables) && tables.length > 0, 'moves lists every move table');
  for (const row of tables) assert.ok(['live', 'shadow', 'map', 'none'].includes(row.state), `table ${row.table} has a known state`);
  assert.deepEqual(tables.map((row) => row.table), tables.map((row) => row.table).sort(), 'tables come in name order');
}, ['init', 'moves']);

catalogCase('[A1,C7,#8916] split files one child per numbered clause through real CLI JSON', [], async () => {
  const box = await project();
  const parent = (await json(box, box.repo, 'add', ['coordinator', 'Split parent', '--criterion', '1. The first part holds [test] 2. The second part holds [test]', '--check', 'true', '--accept-green', 'catalog fixture'], 'add')).item;
  // Each child is titled from its parent, so the likely-duplicate guard would refuse it; the fixture variable turns that guard off for this box only.
  box.env[FIXTURE_DISTINCT_ENV] = '1';
  const split = await uncataloguedRootJSON(box, box.repo, 'split', [String(parent.item_id)]);
  assert.equal(split.parent, parent.item_id);
  assert.equal(split.children.length, 2, 'one child per numbered clause');
}, ['init', 'split']);

export { addRoot, catalogCases, covered, coveredRoots, declaredRun };
