#!/usr/bin/env node
/**
 * Run the test suite with a private home, no inherited Git identity or config, and a refusing CLI shim.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { AGENT_SHELL_MARKERS } from '../src/person.js';

const runner = fileURLToPath(import.meta.url);

/** Quote a path for the private Git shim without interpreting shell metacharacters. */
function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * Build a private environment that makes local tests fail for the same missing Git and CLI setup as CI.
 *
 * @param {string} sandbox
 * @returns {NodeJS.ProcessEnv}
 */
function testEnvironment(sandbox) {
  const home = join(sandbox, 'home');
  const shims = join(sandbox, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(shims, { recursive: true });
  const refusal = join(shims, 'pullboard');
  writeFileSync(refusal, '#!/bin/sh\nprintf "pullboard is not installed; current test: %s\\n" "${PULLBOARD_TEST_FILE:-unknown}" >&2\nexit 1\n');
  chmodSync(refusal, 0o755);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/u)[0];
  const git = join(shims, 'git');
  writeFileSync(git, `#!/bin/sh\nexec ${shellWord(realGit)} -c user.useConfigOnly=true "$@"\n`);
  chmodSync(git, 0o755);

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  // Model a plain user terminal; person-boundary tests inject agent markers explicitly.
  for (const key of AGENT_SHELL_MARKERS) delete env[key];
  env.HOME = home;
  env.USERPROFILE = home;
  env.PULLBOARD_HOME = home;
  env.TMPDIR = sandbox;
  env.TMP = sandbox;
  env.TEMP = sandbox;
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'user.useConfigOnly';
  env.GIT_CONFIG_VALUE_0 = 'true';
  env.PATH = [shims, process.env.PATH].filter(Boolean).join(delimiter);
  delete env.PULLBOARD_RELAY_TOKEN; // Fixtures must supply their own scoped credentials, never an agent’s live bearer.
  delete env.NODE_TEST_CONTEXT;
  delete env.PULLBOARD_TEST_FILE;
  return env;
}

/**
 * Start the Node test runner and return its result to the caller for faithful exit handling.
 *
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runTests(args, env) {
  return spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    '--test',
    '--import',
    runner,
    ...args,
  ], { env, stdio: 'inherit' });
}

/**
 * Launch Node's test runner in a disposable environment and remove it after the run ends.
 *
 * @param {string[]} args
 * @returns {void}
 */
function main(args) {
  const sandbox = mkdtempSync(join(tmpdir(), 'pullboard-test-run-'));
  let signal = null;
  try {
    const result = runTests(args, testEnvironment(sandbox));
    if (result.error) throw result.error;
    signal = result.signal;
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
  if (signal) process.kill(process.pid, signal);
}

if (process.argv[1] && resolve(process.argv[1]) === runner) {
  main(process.argv.slice(2));
} else if (process.argv[1]) {
  process.env.PULLBOARD_TEST_FILE = process.argv[1];
}
