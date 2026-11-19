/** The npm adapter's real form and fake form answer one contract suite [C7,#1429]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeNpmAdapter } from '../../../src/io/adapter/npm.js';
import { createNpmAdapter } from '../../../src/io/adapter/npm.js';
import { createFakeNpmAdapter as frontDoorFake } from '../../../index.js';
import { createNpmAdapter as frontDoorReal } from '../../../index.js';

const DIR = '/work/project';
const CACHE = '/work/cache';
const ANSWER = { code: 0, stderr: 'added 3 packages' };

/** Both forms, each seeded to answer npm ci in DIR with ANSWER; the real form also records each spawn it made. */
function forms() {
  const calls = [];
  const stubbedSpawn = async (command, args, options) => { calls.push([command, args, options.cwd]); return { status: ANSWER.code, stderr: ANSWER.stderr }; };
  return {
    calls,
    all: [
      ['real', createNpmAdapter(stubbedSpawn)],
      ['fake', createFakeNpmAdapter({ [DIR]: ANSWER })],
    ],
  };
}

test('github.io-adapter-npm.ci-answers-code-and-stderr: clause 1: the real form over a stubbed spawn and the fake form both answer ci with { code, stderr }, the real form running npm ci --cache in dir [C7,#1429]', async () => {
  const { calls, all } = forms();
  for (const [form, adapter] of all) {
    assert.deepEqual(await adapter.ci(DIR, { cache: CACHE }), ANSWER, `${form} form answers { code, stderr }`);
  }
  assert.deepEqual(calls, [['npm', ['ci', '--cache', CACHE], DIR]], 'the real form spawns npm ci --cache <cache> in dir');
});

test('github.io-adapter-npm.refuse-bad-input: clause 2: both forms refuse a relative dir or a missing cache with the same named refusal [C7,#1429]', async () => {
  const codes = [];
  for (const [form, adapter] of forms().all) {
    for (const [dir, options] of [['project', { cache: CACHE }], [DIR, {}], [DIR, { cache: '' }]]) {
      await assert.rejects(adapter.ci(dir, options), (error) => { codes.push(error.code); return error.name === 'Refused'; }, `${form} form refuses`);
    }
  }
  assert.deepEqual(codes, Array(6).fill('NPM_CI_INPUT'));
});

test('github.io-adapter-npm.front-door-passes-the-contract: clause 1: createNpmAdapter and createFakeNpmAdapter imported from packages/github/index.js both pass the existing contract table [C7,#1429]', async () => {
  const calls = [];
  const spawn = async (command, args, options) => { calls.push([command, args, options.cwd]); return { status: ANSWER.code, stderr: ANSWER.stderr }; };
  const doors = [['real', frontDoorReal(spawn)], ['fake', frontDoorFake({ [DIR]: ANSWER })]];
  const codes = [];
  for (const [form, adapter] of doors) {
    assert.deepEqual(await adapter.ci(DIR, { cache: CACHE }), ANSWER, `${form} front-door form answers { code, stderr }`);
    for (const [dir, options] of [['project', { cache: CACHE }], [DIR, {}], [DIR, { cache: '' }]]) {
      await assert.rejects(adapter.ci(dir, options), (error) => { codes.push(error.code); return error.name === 'Refused'; }, `${form} front-door form refuses`);
    }
  }
  assert.deepEqual(codes, Array(6).fill('NPM_CI_INPUT'));
  assert.deepEqual(calls, [['npm', ['ci', '--cache', CACHE], DIR]]);
  assert.equal(frontDoorReal, createNpmAdapter, 'the front door exports the adapter module\'s own factory');
  assert.equal(frontDoorFake, createFakeNpmAdapter);
});
