/** Shared fixture for the init ignore journeys: a private Git repo whose hooks run this candidate CLI [I1,I2,I16]. */
import { runFixtureGit } from '../child.js';
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
import { runCliInProcess } from '../process.js';
import { AGENT_SHELL_MARKERS } from '../../../../../packages/kernel/index.js';

/** Create a private Git repo whose installed hooks invoke this candidate CLI only. */
export function fixture(t, ignore) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-init-ignore-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo'); const bin = join(directory, 'bin');
  mkdirSync(root); mkdirSync(bin);
  const cliPath = resolve(import.meta.dirname, '../../../pullboard.js');
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env, HOME: join(directory, 'home'), PULLBOARD_HOME: join(directory, 'board-home'), PULLBOARD_MACHINE_HOME: join(directory, 'machine-home'), PATH: bin + ':' + process.env.PATH };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  delete env.PULLBOARD_RELAY_TOKEN;
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Init Fixture', GIT_AUTHOR_EMAIL: 'init@example.com', GIT_COMMITTER_NAME: 'Init Fixture', GIT_COMMITTER_EMAIL: 'init@example.com' });
  /** Run actual Git and its installed hooks, requiring success. */
  function git(...args) {
    return runFixtureGit(args, { cwd: root, env, encoding: 'utf8' });
  }
  /** Invoke the real command and retain its typed result, including refusals. */
  async function invoke(...args) {
    const result = await runCliInProcess([...args, '--json'], { cwd: root, env });
    return { code: result.status, document: JSON.parse(result.stdout), stderr: result.failure ?? result.stderr, failure: result.failure };
  }
  /** Run the real CLI in its person-facing output mode. */
  async function output(...args) {
    const personEnv = { ...env };
    for (const marker of AGENT_SHELL_MARKERS) delete personEnv[marker];
    const result = await runCliInProcess(args, { cwd: root, env: personEnv });
    return { code: result.status, stdout: result.stdout, stderr: result.failure ?? result.stderr, failure: result.failure };
  }
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Init Fixture'); git('config', 'user.email', 'init@example.com');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', lanes: { web: { owns: ['web/'], specs: [] } } }));
  if (ignore !== undefined) writeFileSync(join(root, '.gitignore'), ignore);
  return { root, git, invoke, output, env };
}
