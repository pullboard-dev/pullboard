/** Init writes Pullboard's skills where each declared agent tool reads them, with the same bytes [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROLES } from '../../index.js';
import { fixtureCommittedGraph } from '../../tests/fixtures/testkit.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

/** A private git project, optionally already declaring an agent tool by its folder, and a runner for real init. */
function fixture(t, declared) {
  const repo = fixtureCommittedGraph('pullboard-codex-skills-');
  t.after(() => rmSync(repo.root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: join(repo.root, '.home-outside'),
    PULLBOARD_HOME: join(repo.root, '.board-outside'),
    PULLBOARD_MACHINE_HOME: join(repo.root, '.machine-outside'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Skills Fixture',
    GIT_AUTHOR_EMAIL: 'skills@example.invalid',
    GIT_COMMITTER_NAME: 'Skills Fixture',
    GIT_COMMITTER_EMAIL: 'skills@example.invalid',
  };
  repo.put('package.json', JSON.stringify({ name: 'codex-skills-fixture', scripts: { test: 'node --test' } }));
  if (declared) repo.put(`${declared}/keep`, '');
  return { root: repo.root, init: () => runCliInProcess(['init', '--json'], { cwd: repo.root, env }) };
}

test('init in a project with no declared tool writes each skill for Claude and for Codex with the same content [C7]', async (t) => {
  const box = fixture(t, null);
  const result = await box.init();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const name of Object.values(ROLES)) {
    const claude = readFileSync(join(box.root, '.claude', 'skills', name, 'SKILL.md'), 'utf8');
    const codex = readFileSync(join(box.root, '.agents', 'skills', name, 'SKILL.md'), 'utf8');
    assert.equal(codex, claude, `${name} reads the same in both skills folders`);
  }
});

test('init in a Codex-only project writes the Codex skills and no Claude skills folder [C7]', async (t) => {
  const box = fixture(t, '.codex');
  const result = await box.init();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readdirSync(join(box.root, '.agents', 'skills')).sort(), Object.values(ROLES).sort());
  assert.equal(existsSync(join(box.root, '.claude', 'skills')), false, 'no Claude skills folder');
});
