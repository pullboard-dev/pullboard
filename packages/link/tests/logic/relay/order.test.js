/** @pullboard-test-input apps/cli/src/io/cli-main/run.js */
/** next, show and claim start no relay link read through git and no maintenance timer after they run [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('../../../../..', import.meta.url).pathname;

/** A repository with one linked worktree, plus a git shim on PATH that logs every call it receives. */
function repository(t) {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'pullboard-read-quiet-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const primary = join(base, 'primary'), linked = join(base, 'linked'), shim = join(base, 'shim'), log = join(base, 'git.log');
  const real = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  fs.mkdirSync(primary); fs.mkdirSync(shim);
  const run = (cwd, ...args) => spawnSync(real, args, { cwd, encoding: 'utf8' });
  run(primary, 'init', '-q', '-b', 'main');
  run(primary, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'seed');
  run(primary, 'worktree', 'add', '-q', '--detach', linked);
  fs.writeFileSync(join(shim, 'git'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
  return { primary, linked, shim, log };
}

test('clause 1: next, show and claim start no relay link (relay.js linkFile git read) - relayLinked on a checkout root runs no git [C7]', async t => {
  const { primary, linked, shim, log } = repository(t);
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim}:${savedPath}`;
  t.after(() => { process.env.PATH = savedPath; });
  const { relayLinked } = await import('../../../index.js');
  for (const root of [primary, linked]) {
    assert.equal(relayLinked(root), false);
  }
  assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', '', 'the link path comes from reading .git, not from git');
});

test('clause 2: next, show and claim start no worktree-maintenance timer or canonical() git call - the quiet set holds exactly them [C7]', () => {
  const source = fs.readFileSync(join(ROOT, 'apps/cli/src/io/cli-main/run.js'), 'utf8');
  assert.match(source, /const QUIET_COMMANDS = new Set\(\['next', 'show', 'claim'\]\);/u);
  assert.match(source, /!QUIET_COMMANDS\.has\(parsed\?\.positionals\[0\]\)\) \{\s*\/\/ The foreground command already read/u);
});
