/** The fixture kit sets a project policy without forcing other settings, and the hand-policy refusal names it [C7]. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIXTURE_HELPERS, fixtureSites } from '../bin/checks/test-fixtures.js';
import { privateFixtureFiles } from './fixture-child.js';
import { fixtureProjectPolicy } from './testkit-fixture.js';

test('clause 1: the kit helper writes exactly the policy a test declares and forces no other setting [C7]', () => {
  const box = privateFixtureFiles('pullboard-kit-policy-');
  const config = { affectedTests: true, landing: { batch: 1 }, lanes: { core: { owns: ['test/'] } } };
  fixtureProjectPolicy(box.root, { config });
  assert.deepEqual(JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8')), config, 'no gate or hand-off is added');
  assert.equal(existsSync(join(box.root, 'SPEC.md')), false, 'a spec is written only when the test supplies one');
  fixtureProjectPolicy(box.root, { config: {}, spec: '# Spec\n' });
  assert.deepEqual(JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8')), {});
  assert.equal(readFileSync(join(box.root, 'SPEC.md'), 'utf8'), '# Spec\n');
});

test('clause 1: the hand-policy refusal names the real helper and its file, never kit.world [C7]', () => {
  const text = fixtureSites("writeFileSync(join(d, 'pullboard.json'), '{}');", 'test/example.test.js')
    .find(row => row.kind === 'hand-policy')?.text ?? '';
  assert.ok(text.includes('fixtureProjectPolicy'), text);
  assert.ok(text.includes(FIXTURE_HELPERS['hand-policy']), text);
  assert.equal(text.includes('kit.world'), false, text);
});
