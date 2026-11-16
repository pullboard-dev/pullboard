/** @pullboard-test-loads packages/config/src/io/main.js */
/** @pullboard-test-loads packages/config/src/io/compat.js */
/** Future coordinator settings do not break old validators or weaken recognized settings [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../src/io/main.js';
import { runFixtureChild } from '../../../../apps/cli/tests/fixtures/child.js';

test('an older validator ignores a future boolean setting and warns once per command with its key and path [N26]', () => {
  const source = `import {configFromSource} from ${JSON.stringify(new URL('../../src/io/main.js', import.meta.url).href)};
const raw={submit:{futureMainRedSwitch:true},futureRootSwitch:true};
const first=configFromSource(JSON.stringify(raw));const second=configFromSource(JSON.stringify(raw));
console.log(JSON.stringify({submit:first.submit,root:Object.hasOwn(first,'futureRootSwitch'),second:second.submit}));`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.failure || result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(Object.hasOwn(parsed.submit, 'futureMainRedSwitch'), false);
  assert.equal(parsed.submit.autoFileMainReds, false, 'ignoring a future opt-in cannot enable a known authority option');
  assert.equal(parsed.root, false);
  assert.deepEqual(parsed.second, parsed.submit);
  const notes = result.stderr.split('\n').filter(line => line.startsWith('pullboard: ignoring unknown setting'));
  assert.equal(notes.length, 2, 'each unknown path is logged once even when the config is parsed twice');
  assert.ok(notes.some(line => line.includes('"submit"."futureMainRedSwitch"')));
  assert.ok(notes.some(line => line.includes('"futureRootSwitch"')));
});

test('known settings still reject wrong types and invalid values beside future settings [N26]', () => {
  for (const raw of [
    { submit: { futureSwitch: true, autoFileMainReds: 'true' } },
    { submit: { futureSwitch: true, requireInfraNote: 1 } },
    { submit: { handoff: 'true' } },
    { landing: { futureSwitch: true, parallel: 'yes' } },
    { landing: { environment: { platform: 'darwin', arch: 'arm64', node: 'latest' } } },
    { landing: { cadence: { every: '10m', accepted: 0 } } },
    { verify: { policy: 'anyone' } },
    { registryGuards: [{ inputs: ['src/**'], tests: ['../outside.test.js'] }], affectedTests: 'node --test' },
  ]) assert.throws(() => configFromSource(JSON.stringify(raw)), { code: 'BAD_CONFIG' });
});

test('unknown keys never inherit schema authority and warnings contain no setting values [N26]', () => {
  const source = `import {configFromSource} from ${JSON.stringify(new URL('../../src/io/main.js', import.meta.url).href)};
const raw=JSON.parse('{"submit":{"constructor":"private-value","__proto__":{"autoFileMainReds":true},"line\\\\nkey":"private-value"}}');
console.log(JSON.stringify({ got: configFromSource(JSON.stringify(raw)).submit, defaults: configFromSource('{}').submit }));`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.failure || result.stderr);
  const { got, defaults } = JSON.parse(result.stdout);
  assert.deepEqual(got, defaults, 'unknown keys leave every submit setting at its default, whatever settings it gains');
  assert.equal(got.autoFileMainReds, false);
  assert.equal(got.requireInfraNote, false);
  assert.doesNotMatch(result.stderr, /private-value/u);
  assert.equal(result.stderr.split('\n').filter(line => line.startsWith('pullboard: ignoring unknown setting')).length, 3);
});

test('known dynamic policy maps and downstream authority settings retain their exact bytes [N26]', () => {
  const raw = { maintainers: ['maintainer@example.invalid'], sandbox: { customAuthority: 'preserve for its owner validator' },
    intake: { sensitivePaths: ['src/secret-policy.js'] }, families: { Vendor: ['Alias'] },
    lanes: { web: { owns: ['web/'], specs: ['V1'], starts: 'worktree' } }, products: { Website: ['V1'] } };
  const config = configFromSource(JSON.stringify(raw));
  for (const key of Object.keys(raw)) assert.deepEqual(config[key], raw[key], key);
});

test('known health thresholds survive forward-compatible filtering [A6,N26]', () => {
  const health = { sentinel: false, stuck: '0m', holds: '2h', release: '3d' };
  assert.deepEqual(configFromSource(JSON.stringify({ health })).health, health);
});

test('malformed configuration roots and known groups are not converted into defaults [N26]', () => {
  for (const raw of [null, [], true, { submit: [] }, { submit: null }, { landing: [] }, { claims: 'yes' }]) {
    assert.throws(() => configFromSource(JSON.stringify(raw)), { code: 'BAD_CONFIG' });
  }
});

/** The known optional handoff survives forward compatibility filtering without changing defaults. */
test('optional handoff setting is retained and validated [N26,V4]', () => {
  assert.equal(configFromSource('{}').submit.handoff, undefined);
  assert.equal(configFromSource(JSON.stringify({ submit: { handoff: true } })).submit.handoff, true);
  assert.equal(configFromSource(JSON.stringify({ submit: { handoff: false } })).submit.handoff, false);
});
