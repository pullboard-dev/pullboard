/** @pullboard-test-input source-cell landing */
/** landing.staticAffectedOnly: a changed gate data file no longer widens the landing static guard to the whole run [C7,#9077]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
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

test('landing.static-affected.with-landing-staticaffectedonly-on-a-batch: clause 1: with landing.staticAffectedOnly on, a batch whose only changed .json is one gate data file hands the static command just that path [C7,#9077]', async t => {
  const { seen } = await commandFor(t, { [DATA]: '{"a":1}\n' }, { affectedOnly: true });
  assert.match(seen, /^export PULLBOARD_STATIC_SCOPE='\["packages\/gate\/data\/baselines\/cli-launches\.json"\]'; node static\.js$/u);
});

test('landing.static-affected.with-it-on-package-json-a: clause 1: with it on, package.json, a .json outside gate data and a deleted file still run the whole static command [C7,#9077]', async t => {
  for (const changes of [{ 'package.json': '{"a":1}\n' }, { 'web/other.json': '{}\n' }, { [DATA]: null }]) {
    const { seen } = await commandFor(t, changes, { affectedOnly: true });
    assert.equal(seen, 'node static.js', JSON.stringify(changes));
  }
});

test('landing.static-affected.with-it-on-a-red-check: clause 2: with it on, a red check on a changed file still refuses LAND_STATIC_RED naming its file and line [C7,#9077]', async t => {
  const { result } = await commandFor(t, { [DATA]: '{"a":1}\n' }, { affectedOnly: true }, `${DATA}:1: ceiling grew`);
  assert.equal(result.ok, false);
  assert.match(result.detail, /^LAND_STATIC_RED: .*packages\/gate\/data\/baselines\/cli-launches\.json:1: ceiling grew/u);
});

test('landing.static-affected.with-landing-staticaffectedonly-off-the-default: clause 3: with landing.staticAffectedOnly off (the default), a changed .json file keeps the whole static command [C7,#9077]', async t => {
  const off = await commandFor(t, { [DATA]: '{"a":1}\n' });
  assert.equal(off.seen, 'node static.js');
  const explicit = await commandFor(t, { [DATA]: '{"a":1}\n' }, { affectedOnly: false });
  assert.equal(explicit.seen, 'node static.js');
});

const RATCHET = 'packages/gate/data/baselines/new-ratchet.json';
/** The new ratchet's check: prints path:line: text for each web/ line holding the marker, over PULLBOARD_STATIC_SCOPE when set, else every web/ file. */
const CHECK = `import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const scope = process.env.PULLBOARD_STATIC_SCOPE ? JSON.parse(process.env.PULLBOARD_STATIC_SCOPE) : null;
const files = (scope ?? execFileSync('git', ['ls-files', 'web'], { encoding: 'utf8' }).split('\\n').filter(Boolean)).filter(file => file.startsWith('web/'));
let red = false;
for (const file of files) readFileSync(file, 'utf8').split('\\n').forEach((text, index) => { if (/OFF[E]NDER/u.test(text)) { red = true; console.log(file + ':' + (index + 1) + ': ' + text); } });
process.exit(red ? 1 : 0);
`;

/** job.js's command runner in miniature: the argv really runs in the root and answers ok, detail and output. */
const realCommand = argv => async ({ root }) => {
  const ran = spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8' });
  return { ok: ran.status === 0, detail: ran.status === 0 ? null : `exit ${ran.status}`, output: `${ran.stdout}${ran.stderr}` };
};

/** The branch point holds a file with an offender the batch never touches; the batch adds a new ratchet and its check. */
function offenderOnMain(t) {
  const { root, put } = fixture(t);
  put('web/old.txt', 'fine\nOFFENDER here\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore: main holds an offender');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  put(RATCHET, '{"ceiling":0}\n');
  put('web/check.mjs', CHECK);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'feat: a new ratchet and its check');
  return { root, base };
}

test('landing.static-affected.a-new-ratchet-meets-a-new-offender-on-main: clause 1: a batch that adds a gate data ratchet and its check is judged on the whole merged tree, so an offender main holds in an untouched file is LAND_STATIC_RED with affectedOnly false and true [C7,#7068]', async t => {
  for (const affectedOnly of [false, true]) {
    const { root, base } = offenderOnMain(t);
    const result = await staticGuardCheck('node web/check.mjs', realCommand, { affectedOnly })({ root, base });
    assert.equal(result.ok, false, `affectedOnly ${affectedOnly}`);
    assert.match(result.detail, /^LAND_STATIC_RED: .*web\/old\.txt:2: OFFENDER here/u, `affectedOnly ${affectedOnly}`);
  }
});

test('landing.static-affected.an-added-gate-data-json-keeps-the-whole-command: clause 2: with affectedOnly on, an added (status A) gate data JSON keeps the whole static command, while a modified one still hands the command just its path [C7,#7068]', async t => {
  const added = await commandFor(t, { 'packages/gate/data/baselines/brand-new.json': '{}\n' }, { affectedOnly: true });
  assert.equal(added.seen, 'node static.js');
  const modified = await commandFor(t, { [DATA]: '{"a":2}\n' }, { affectedOnly: true });
  assert.match(modified.seen, /^export PULLBOARD_STATIC_SCOPE='\["packages\/gate\/data\/baselines\/cli-launches\.json"\]'; node static\.js$/u);
});
