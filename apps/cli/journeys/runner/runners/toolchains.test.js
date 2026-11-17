/** A job is enqueued only to a runner that records every toolchain the machine requires, and a blank setting filters nothing [C7,#3969]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateRunnerLoadPolicy } from '../../../../../packages/gate/index.js';
import { pickTieredRunner } from '../../../../../packages/resources/src/io/runner/pick.js';

const NOW = Date.parse('2026-11-16T12:00:00Z');
/** Two idle runners with live load readings; only the second records toolchains. */
const PLAIN = { host: 'plain-box', slots: 2, browser: 0, cores: 8, cpuLoad: { at: new Date(NOW - 1000).toISOString(), busyPercent: 1, average: [0.1, 0.1, 0.1] } };
const EQUIPPED = { host: 'tool-box', slots: 2, browser: 0, cores: 8, toolchains: { node: '22', python: '3.12' }, cpuLoad: { at: new Date(NOW - 1000).toISOString(), busyPercent: 90, average: [6, 6, 6] } };
const usage = () => ({ slots: 0, browsers: 0, landingShards: 0, admittedSince: 0 });
/** The real runner choice for one job under a machine settings file's content. */
const choose = (settings, runners = [PLAIN, EQUIPPED]) => pickTieredRunner(runners, new Set(), false, usage, gateRunnerLoadPolicy(settings), NOW).selected?.host;

test('clause 2: with the setting naming a toolchain, a job goes only to the runner whose recorded toolchains include every named one [C7]', () => {
  assert.equal(choose({ 'runners.requiredToolchains': 'node' }), 'tool-box', 'the plain runner has more headroom but lacks node');
  assert.equal(choose({ 'runners.requiredToolchains': 'node, python' }), 'tool-box', 'every name must be recorded');
  assert.equal(choose({ 'runners.requiredToolchains': 'node,cargo' }), undefined, 'no runner has cargo, so the job waits in the queue');
});

test('clause 3: with the setting blank or unset every compatible runner is still eligible [C7]', () => {
  assert.equal(choose({}), 'plain-box', 'unset: the runner with the most headroom wins');
  assert.equal(choose({ 'runners.requiredToolchains': null }), 'plain-box');
  assert.equal(choose({ 'runners.requiredToolchains': '' }), 'plain-box');
  assert.equal(choose({ 'runners.requiredToolchains': ' , ' }), 'plain-box', 'only separators name nothing');
});
