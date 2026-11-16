/** Init writes a Claude worker-loop skill generated from the one shared seat-loop source [C7,#8550]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { SHIPPED_SKILL_DIGESTS } from '../../index.js';
import { SEAT_LOOP } from '../../../../packages/config/index.js';
import { renderWorkerSkill } from '../../../../packages/config/index.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

test('clause 1: init writes a Claude worker-loop skill that matches the shared seat-loop source [C7]', async t => {
  const inputs = privateFixtureFiles('pullboard-worker-skill-');
  const root = inputs.root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.com'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'base']]) {
    assert.equal(runFixtureChild('git', args, { cwd: root, encoding: 'utf8' }).status, 0);
  }
  const result = await runCliInProcess(['init'], { cwd: root, env: { ...process.env, CI: '1' } });
  const written = readFileSync(`${root}/.claude/skills/pullboard-worker/SKILL.md`, 'utf8');
  assert.equal(written, renderWorkerSkill(), `init wrote the generated skill (init exit ${result.status})`);
  const loopBody = SEAT_LOOP.slice(SEAT_LOOP.indexOf('\n') + 1);
  assert.ok(written.includes(loopBody), 'the skill carries the shared seat loop word for word');
  const digest = createHash('sha256').update(written).digest('hex');
  assert.ok(SHIPPED_SKILL_DIGESTS.worker[digest], 'the digest table lists the shipped worker skill');
});
