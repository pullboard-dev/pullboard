/** landing.staticAffectedOnly: a changed gate data file no longer widens the landing static guard to the whole run [C7,#9077]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staticGuardCheck } from '../../src/io/runner/static.js';
import { fixture } from '../fixtures/plan.js';
import { git } from '../fixtures/plan.js';

const DATA = 'packages/gate/data/baselines/cli-launches.json';

/** A repository whose branch point is `base` and whose HEAD adds the given files (or removes them, when the text is null). */
function repository(t, changes) {
  const { root, put } = fixture(t);
  put('web/a.txt', 'a\n');
  put(DATA, '{}\n');
  put('package.json', '{}\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore: base');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  for (const [file, text] of Object.entries(changes)) { if (text === null) git(root, 'rm', '-q', file); else put(file, text); }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'feat: change');
  return { root, base };
}

/** Run the guard and answer the shell command it handed the runner. */
async function commandFor(t, changes, options, output = null) {
  const { root, base } = repository(t, changes);
  let seen = null;
  const check = staticGuardCheck('node static.js', argv => async () => { seen = argv[2]; return output ? { ok: false, output } : { ok: true, detail: null }; }, options);
  const result = await check({ root, base });
  return { seen, result };
}

test('clause 1: with landing.staticAffectedOnly on, a batch whose only changed .json is one gate data file hands the static command just that path [C7,#9077]', async t => {
  const { seen } = await commandFor(t, { [DATA]: '{"a":1}\n' }, { affectedOnly: true });
  assert.match(seen, /^export PULLBOARD_STATIC_SCOPE='\["packages\/gate\/data\/baselines\/cli-launches\.json"\]'; node static\.js$/u);
});

test('clause 1: with it on, package.json, a .json outside gate data and a deleted file still run the whole static command [C7,#9077]', async t => {
  for (const changes of [{ 'package.json': '{"a":1}\n' }, { 'web/other.json': '{}\n' }, { [DATA]: null }]) {
    const { seen } = await commandFor(t, changes, { affectedOnly: true });
    assert.equal(seen, 'node static.js', JSON.stringify(changes));
  }
});

test('clause 2: with it on, a red check on a changed file still refuses LAND_STATIC_RED naming its file and line [C7,#9077]', async t => {
  const { result } = await commandFor(t, { [DATA]: '{"a":1}\n' }, { affectedOnly: true }, `${DATA}:1: ceiling grew`);
  assert.equal(result.ok, false);
  assert.match(result.detail, /^LAND_STATIC_RED: .*packages\/gate\/data\/baselines\/cli-launches\.json:1: ceiling grew/u);
});

test('clause 3: with landing.staticAffectedOnly off (the default), a changed .json file keeps the whole static command [C7,#9077]', async t => {
  const off = await commandFor(t, { [DATA]: '{"a":1}\n' });
  assert.equal(off.seen, 'node static.js');
  const explicit = await commandFor(t, { [DATA]: '{"a":1}\n' }, { affectedOnly: false });
  assert.equal(explicit.seen, 'node static.js');
});
