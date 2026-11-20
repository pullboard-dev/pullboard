/** Shared private-CLI setup for the agent-session journeys [B3,B7,N2,B13]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { privateFixtureFiles } from '../child.js';
import { runFixtureGit } from '../child.js';
import { runCliInProcess } from '../process.js';
import { fixtureSettledMachine } from '../testkit.js';
import { fixtureProjectPolicy } from '../testkit.js';

export const BIN = resolve(import.meta.dirname, '../../../pullboard.js');
const DIRS = [];
const MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI', 'CODEX_SHELL'];
export const SPEC = '# Session fixture\n\n## G · Goals\n- G1 [approved, must] The fixture works. | gate: true\n';
export const CONFIG = { gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h', lanes: { web: { owns: ['web/'], specs: ['G1'] } }, shared: ['docs/'] };

/** Remove every private fixture directory a journey file created. */
export function cleanupSandboxes() { for (const dir of DIRS) rmSync(dir, { recursive: true, force: true }); }

/** Build a private CLI environment without ambient agent/session or Git selectors. */
export function sandbox() {
  const dir = privateFixtureFiles('pullboard-agent-session-').root;
  DIRS.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${BIN.replaceAll("'", "'\\''")}' "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const base = { ...process.env };
  for (const key of Object.keys(base)) if (key.startsWith('GIT_') || MARKERS.includes(key) || key === 'CLAUDE_CODE_SESSION_ID') delete base[key];
  Object.assign(base, {
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), PATH: `${bin}:${process.env.PATH}`,
    // No detached claim beater or usage checkpoint outlives a case: the gate's child drain waits up to 30 s for each at exit (#10680).
    PULLBOARD_CLAIM_BEATER: '0', PULLBOARD_USAGE_CHECKPOINT: 'inline',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Session fixture', GIT_AUTHOR_EMAIL: 'session@example.invalid',
    GIT_COMMITTER_NAME: 'Session fixture', GIT_COMMITTER_EMAIL: 'session@example.invalid',
  });
  fixtureSettledMachine(base.PULLBOARD_MACHINE_HOME);
  /** Run real Git with the private environment. */
  function git(cwd, ...args) {
    return runFixtureGit(args, { cwd, env: base });
  }
  /** Run the actual CLI dispatch in process with an explicit agent session or markerless terminal. */
  function inProcess(cwd, args, { session, sessionKey = 'CLAUDE_CODE_SESSION_ID', agent = true, extra = {} } = {}) {
    const env = { ...base, ...extra };
    if (agent) {
      env.CLAUDECODE = '1';
      if (session !== undefined) env[sessionKey] = session;
    }
    return runCliInProcess(args, { cwd, env });
  }
  return { dir, base, git, inProcess };
}

/** Create the main checkout and one joined lane worktree with a private board. */
export async function project() {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal((await box.inProcess(repo, ['init'], { agent: false })).status, 0);
  fixtureProjectPolicy(repo, { config: CONFIG, spec: SPEC });
  mkdirSync(join(repo, 'web'));
  writeFileSync(join(repo, 'web', 'page.txt'), 'ready\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: initialize session fixture');
  const added = (await box.inProcess(repo, ['add', 'web', 'fixture item', '--specs', 'G1', '--json'], { agent: false }));
  assert.equal(added.status, 0, `${added.stdout}${added.stderr}`);
  const web = join(box.dir, 'web-agent');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/session');
  const joined = (await box.inProcess(web, ['join', 'web', '--family', 'Fixture-Builder', '--route', 'strong'], { agent: false }));
  assert.equal(joined.status, 0, `${joined.stdout}${joined.stderr}`);
  return { ...box, repo, web, boardFile: resolve(repo, box.git(repo, 'rev-parse', '--git-common-dir'), 'pullboard', 'board.sqlite') };
}

/** Capture stable board counts so a refused write proves no event, row, or shout was added. */
export function boardSnapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name}) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
  } finally { db.close(); }
}

/** Keep raw ids out of SQLite and local files; only the current digest lives in this checkout’s Git directory. */
export function assertNoRawSession(box, cwd, secrets, sessionKey = 'CLAUDE_CODE_SESSION_ID') {
  const file = box.boardFile;
  const dir = file.slice(0, file.lastIndexOf('/'));
  const files = readdirSync(dir).filter((name) => /board\.sqlite(?:-(?:wal|shm))?$/u.test(name));
  assert.ok(files.length, 'private SQLite board files were created');
  for (const name of files) {
    const bytes = readFileSync(join(dir, name));
    for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret)), false, `raw session id is not persisted in ${name}`);
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
    const stored = tables.flatMap((table) => db.prepare(`SELECT * FROM \"${table.replaceAll('\"', '\"\"')}\"`).all())
      .map((row) => JSON.stringify(row)).join('\\n');
    for (const secret of secrets) {
      const digest = createHash('sha256').update(JSON.stringify([sessionKey, secret])).digest('hex');
      assert.equal(stored.includes(digest), false, 'session bindings never enter shared board data');
    }
  } finally { db.close(); }
  const local = resolve(cwd, box.git(cwd, 'rev-parse', '--git-dir'), 'pullboard-checkout-session.json');
  const bindingText = readFileSync(local, 'utf8');
  for (const secret of secrets) assert.equal(bindingText.includes(secret), false);
  const binding = JSON.parse(bindingText);
  assert.equal(binding.agent, cwd === box.repo ? 'coordinator' : 'web-1');
  assert.equal(binding.digest, createHash('sha256').update(JSON.stringify([sessionKey, secrets.at(-1)])).digest('hex'));
  assert.ok(Number.isFinite(Date.parse(binding.at)));
}
