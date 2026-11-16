/** Shared sandbox for the doctrine naming journeys: private Git and pullboard homes, one real CLI shim [D1,D2,A5]. */
import assert from 'node:assert/strict';
import { runFixtureGit } from './child.js';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { after } from 'node:test';
import { runCliInProcess } from './process.js';

export const BIN = resolve(import.meta.dirname, '../../pullboard.js');
export const DOCTRINE = 'DOCTRINE.md';
export const PRACTICE = 'PRACTICE.md';
const TEMP_DIRS = [];
const LEGACY_RULES = '# Legacy doctrine\n\n## L · Local\n- L1 [fact] Keep the legacy rule.\n';
const LOCAL_RULE = '\n## L · Local\n- L1 [fact] Keep this repo rule.\n';

/** Remove all fixture repos and their private SQLite homes after the tests finish. */
function cleanup() {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
}

after(cleanup);

/** Quote a shell argument for the private hook shim. */
export function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Make private Git and pullboard homes with a real CLI subprocess and PATH shim. */
export function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-doctrine-name-'));
  TEMP_DIRS.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: join(dir, 'home'),
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Doctrine name fixture',
    GIT_AUTHOR_EMAIL: 'doctrine-name@example.invalid',
    GIT_COMMITTER_NAME: 'Doctrine name fixture',
    GIT_COMMITTER_EMAIL: 'doctrine-name@example.invalid',
  });
  /** Run Git with the fixture's isolated identity and configuration. */
  function git(cwd, ...args) {
    return runFixtureGit(args, { cwd, env });
  }
  /** Run one real CLI command in this process and keep stdout, stderr and status available to assertions. */
  function inProcess(cwd, ...args) {
    return runCliInProcess(args, { cwd, env });
  }
  return { dir, env, git, inProcess };
}


/** Make a committed pre-init rename fixture, optionally adding a later collision on main. */
export function renamedDoctrineFixture(box, name, { laterCollision = false, commitRename = true } = {}) {
  const root = join(box.dir, name);
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  const originalSpec = '# Requirements\n\n## G · Goals\n- G1 [draft, aim] Existing requirement.\n';
  const originalPractice = '# Legacy rules\n\n## G · Goals\n- G1 [draft] Existing collision.\n- G2 [draft] Legacy id without a collision.\n';
  writeFileSync(join(root, 'SPEC.md'), originalSpec);
  writeFileSync(join(root, PRACTICE), originalPractice);
  box.git(root, 'add', 'SPEC.md', PRACTICE);
  box.git(root, 'commit', '-q', '-m', 'docs: seed legacy doctrine collision');
  box.git(root, 'mv', PRACTICE, DOCTRINE);
  if (commitRename) box.git(root, 'commit', '-q', '-m', 'docs: rename practice to doctrine');
  if (laterCollision) {
    const updatedSpec = `${originalSpec.trimEnd()}\n- G2 [draft, aim] Added after the doctrine rename.\n`;
    writeFileSync(join(root, 'SPEC.md'), updatedSpec);
    box.git(root, 'add', 'SPEC.md');
    box.git(root, 'commit', '-q', '-m', 'docs: add post-rename collision');
  }
  return root;
}

/** Run spec JSON and return its rows after checking the CLI result. */
export async function specRows(box, root) {
  const result = await box.inProcess(root, 'spec', '--json');
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout).rows;
}
