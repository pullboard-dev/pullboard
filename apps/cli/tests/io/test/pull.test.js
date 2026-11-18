/** A test job request carries the caller's fixture switches and nothing else from its shell [C7,#10849]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { cellRepo } from '../../../../../packages/store/tests/fixtures/cell.js';
import { test } from 'node:test';
import { testJobRow } from '../../../src/io/test/pull.js';

const SHELL = { PATH: '/usr/bin', HOME: '/home/user', NODE_OPTIONS: '--require ./evil.js', FIXTURE_ONE: '1', PULLBOARD_FIXTURE_INPROCESS_HOOKS: '1', PULLBOARD_FIXTUREX: 'no', MY_FIXTURE_A: 'no' };

/** The row testJobRow offers for a commit in a throwaway repository, given the caller's shell variables. */
async function rowFor(t, environment) {
  const { root, commit } = cellRepo(t, { real: true });
  const { row } = await testJobRow({ info: { root } }, { item: 1, commit, main: commit, command: 'true', files: [], environment });
  return row;
}

test('cli.io-test-pull.forwards-fixture-variables: clause 1: testJobRow puts every caller variable matching the job env allowlist into the request env map [C7,#10849]', async t => {
  const row = await rowFor(t, SHELL);
  assert.deepEqual(row.request.env, { FIXTURE_ONE: '1', PULLBOARD_FIXTURE_INPROCESS_HOOKS: '1' });
});

test('cli.io-test-pull.leaves-other-variables-out: clause 2: testJobRow leaves PATH, HOME, NODE_OPTIONS and every other non-matching variable out of the request [C7,#10849]', async t => {
  const row = await rowFor(t, SHELL);
  for (const name of ['PATH', 'HOME', 'NODE_OPTIONS', 'PULLBOARD_FIXTUREX', 'MY_FIXTURE_A']) assert.equal(name in row.request.env, false, name);
  const bare = await rowFor(t, { PATH: '/usr/bin' });
  assert.equal('env' in bare.request, false, 'a shell with no fixture variable adds no env map');
});
