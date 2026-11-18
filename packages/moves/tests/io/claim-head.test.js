/** claim.refuseOffMainHead: on, claim refuses a folder whose HEAD is not on main with a next step; off (the default), claim takes it as before [C7,#9104]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { offMainHeadRefusal } from '../../index.js';
import { describeSetting } from '../../../config/index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../gate/tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';
import { fixtureCommitAll } from '../../../gate/tests/fixtures/testkit.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Claim head fixture', GIT_AUTHOR_EMAIL: 'claim@example.invalid', GIT_COMMITTER_NAME: 'Claim head fixture', GIT_COMMITTER_EMAIL: 'claim@example.invalid' };

/** A real repository on main with one commit; `commit` adds one on whatever HEAD is. */
function repository(t) {
  const { root } = privateFixtureFiles('pullboard-claim-head-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...IDENTITY };
  const git = (...args) => runFixtureSetupGit(args, { cwd: root, env });
  writeFileSync(join(root, 'base.txt'), 'base\n');
  fixtureCommitAll(root);
  const commit = (file, text) => { writeFileSync(join(root, file), text); git('add', '-A'); git('commit', '-q', '-m', `chore: ${file}`); return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root, env }); };
  return { root, git, commit };
}

/** Run `read` with a private machine home holding `settings`, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root } = privateFixtureFiles('pullboard-claim-head-home-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(root, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(root, { recursive: true, force: true });
  }
}

test('moves.claim-head.refuse-on: clause 1: with claim.refuseOffMainHead on, claim in a folder whose HEAD is not on main refuses CLAIM_HEAD_OFF_MAIN with a clear next step [C7,#9104]', t => {
  const { root, git, commit } = repository(t);
  git('checkout', '-q', '--detach', 'main');
  commit('early.txt', 'committed before claiming\n');
  const refusal = withSettings({ claim: { refuseOffMainHead: true } }, () => offMainHeadRefusal(root, { trunk: 'main' }));
  assert.equal(refusal?.code, 'CLAIM_HEAD_OFF_MAIN');
  assert.match(refusal.message, /is not on main/u);
  assert.match(refusal.next, /git checkout --detach main/u, 'the next step puts the folder back on main');
  assert.match(refusal.next, /claim again/u);
  assert.equal(offMainHeadRefusal(root, { trunk: 'main', enabled: true })?.code, 'CLAIM_HEAD_OFF_MAIN');
  git('checkout', '-q', '--detach', 'main');
  assert.equal(offMainHeadRefusal(root, { trunk: 'main', enabled: true }), null, 'a folder on main\'s tip claims');
  commit('later.txt', 'main moves on\n');
  git('branch', '-q', '-f', 'main', 'HEAD');
  git('checkout', '-q', '--detach', 'HEAD~1');
  assert.equal(offMainHeadRefusal(root, { trunk: 'main', enabled: true }), null, 'a folder on an older main commit claims');
});

test('moves.claim-head.refuse-off: clause 2: with claim.refuseOffMainHead off (the default), claim takes a folder off main as before, and the setting is described [C7,#9104]', t => {
  const { root, git, commit } = repository(t);
  git('checkout', '-q', '--detach', 'main');
  commit('early.txt', 'committed before claiming\n');
  assert.equal(withSettings({}, () => offMainHeadRefusal(root, { trunk: 'main' })), null, 'unset reads as off');
  assert.equal(withSettings({ claim: { refuseOffMainHead: false } }, () => offMainHeadRefusal(root, { trunk: 'main' })), null);
  assert.equal(offMainHeadRefusal(root, { trunk: 'main', enabled: false }), null);
  const described = describeSetting('claim.refuseOffMainHead');
  assert.ok(described.label, 'the setting carries a plain label');
  assert.match(described.description, /HEAD is not on main/u);
  assert.equal(described.unit, 'on/off');
});
