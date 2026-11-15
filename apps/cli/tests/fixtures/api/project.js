/** Disposable real-repo project fixtures and the JSON-shape checker for the API journeys [A1,A2]. */
import assert from 'node:assert/strict';
import { runFixtureChild } from '../child.js';
import { runFixtureGit } from '../child.js';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { delimiter } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after } from 'node:test';
import { JSON_SHAPES } from '../../../../../packages/config/index.js';
import { SSH_SHELL_MARKERS } from '../../../../../packages/kernel/index.js';
import { AGENT_SHELL_MARKERS } from '../../../../../packages/kernel/index.js';
import { assertRequiredShape } from '../api.js';
import { shellWord } from '../api.js';

const BIN = resolve(import.meta.dirname, '../../../pullboard.js');

const TEMP_DIRS = [];
const covered = new Set();
const coveredRoots = new Set();
after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});
export const SPEC = `# API fixture
## G · Goals
- G1 [approved, must] The fixture keeps its board. | gate: true
`;
/** Make a disposable home and a real repo with isolated git settings. */
export function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-api-')));
  TEMP_DIRS.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'API Test',
    GIT_AUTHOR_EMAIL: 'api@example.invalid',
    GIT_COMMITTER_NAME: 'API Test',
    GIT_COMMITTER_EMAIL: 'api@example.invalid',
    PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: join(dir, 'home'),
    HOME: join(dir, 'private-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'home'),
  };
  delete env.PULLBOARD_RELAY_TOKEN;
  delete env.PULLBOARD_STARTUP_TRACE_FILE;
  delete env.PULLBOARD_STARTUP_TRACE_ENTRY;
  delete env.PULLBOARD_STARTUP_TEST_HOLD_PHASE;
  delete env.PULLBOARD_STARTUP_TEST_PHASE_REACHED_FILE;
  delete env.PULLBOARD_STARTUP_TEST_RELEASE_FILE;
  for (const marker of SSH_SHELL_MARKERS) delete env[marker];
  for (const marker of AGENT_SHELL_MARKERS) delete env[marker];
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
  const run = (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  return { dir, env, git, run };
}
/** Initialize a real board with an undeclared legacy coordinator for the API protocol fixtures. */
export function project() {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const inheritedModel = box.env.PULLBOARD_MODEL;
  delete box.env.PULLBOARD_MODEL;
  const initialized = json(box, repo, 'init');
  if (inheritedModel !== undefined) box.env.PULLBOARD_MODEL = inheritedModel;
  const configFile = join(repo, 'pullboard.json');
  // These fixtures prove API shapes with "true" checks, so they keep a board with no hold setting.
  const { checks: _hold, ...config } = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, `${JSON.stringify({
    ...config,
    gate: 'true',
    spec: 'SPEC.md',
    practice: 'DOCTRINE.md',
    lanes: {
      app: { owns: ['app/'], specs: ['G1'] },
      review: { owns: [] },
    },
    shared: [],
  }, null, 2)}\n`);
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  writeFileSync(join(repo, 'DOCTRINE.md'), '');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up API fixture');
  return { ...box, repo, initialized };
}
/** Resolve the catalog entry for either a root command or a documented subcommand. */
export function shapeFor(command, subcommand) {
  const candidates = [
    ...(subcommand ? [`${command} ${subcommand}`, `${command}.${subcommand}`, `${command}:${subcommand}`] : []),
    command,
  ];
  const key = candidates.find((candidate) => JSON_SHAPES.commands[candidate]);
  assert.ok(key, `JSON_SHAPES.commands must document ${command}${subcommand ? ` ${subcommand}` : ''}`);
  covered.add(key);
  coveredRoots.add(command);
  return JSON_SHAPES.commands[key];
}

/** Parse a command's sole JSON document and check its public command shape. */
export function json(box, cwd, command, args = [], subcommand) {
  const result = box.run(cwd, command, ...args, '--json');
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr}${result.stdout}`);
  const document = JSON.parse(result.stdout);
  if (command === 'check' && subcommand !== 'accept') {
    assert.equal(result.stderr, `check #${document.id} set by ${document.by} (unknown): ${document.check}\n`, 'check attribution is visible before execution while stdout remains one JSON document');
  } else assert.equal(result.stderr, '', `${command} --json must keep stderr empty`);
  assert.equal(document.version, 1, `${command} --json has a version 1 envelope`);
  assertRequiredShape(document, shapeFor(command, subcommand).required, command);
  return document;
}

/** Read the event-log marker without going through openBoard's version guard. */
export function readEventLogVersion(file) {
  const db = new DatabaseSync(file);
  try { return db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('event_log_version')?.meta_value; }
  finally { db.close(); }
}
/** Set a private fixture's event-log marker to model another reader's persisted format. */
export function setEventLogVersion(file, version) {
  const db = new DatabaseSync(file);
  try {
    db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value')
      .run('event_log_version', String(version));
  } finally { db.close(); }
}
