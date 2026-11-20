/** @pullboard-test-input source-cell packages/moves */
/** @pullboard-world-pin reads every tracked file under packages/moves to prove none names a machine host [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WORD = ['van', 'illa'].join('');

test('moves.privacy.no-host-name: clause 1: no tracked file under packages/moves contains the machine host name [C7]', () => {
  const files = execFileSync('git', ['ls-files', '-z', 'packages/moves'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  const hits = files.filter((f) => readFileSync(join(ROOT, f), 'utf8').toLowerCase().includes(WORD));
  assert.deepEqual(hits, []);
});

test('moves.privacy.submit-history-parses: clause 2: the recorded submit history still parses with its events and a neutral runner name [C7]', () => {
  const history = JSON.parse(readFileSync(join(ROOT, 'packages/moves/tests/fixtures/table/submit-history.json'), 'utf8'));
  assert.ok(history.events.length > 0);
  assert.ok(JSON.stringify(history).includes('"runner":"studio-host"'));
});

/** The fields of a recorded event that hold free prose, where a live board note would sit. */
const PROSE = new Set(['text', 'note', 'reason', 'message', 'assertion', 'brief', 'criterion', 'check', 'name', 'caseNames', 'milestone', 'firstError', 'stable', 'command', 'warning', 'clauseText', 'unpinned', 'dropped', 'clause', 'cause', 'key', 'summary', 'detail', 'title', 'why']);

/** The neutral placeholder text the scrubs wrote, a bare refusal or state code, a result word and a digest. */
const NEUTRAL = /^(?:\[[A-Z_]+\] |[A-Z_]+: |refusal:)?(?:recorded (?:note|case|refusal note|assertion)(?: \d+)?|scrubbed reason|x|held|override|green|red|pending|[A-Z][A-Z0-9_]+|[0-9a-f]{64})$/u;

/** The sentences the board itself writes, whose only free parts are ids, counts, times and the neutral placeholder. */
const MECHANICAL = new RegExp('^(?:Gate job gate:\\d+:|policy re-frozen automatically: |Returned after two hours without a new submit; |registered worktree no longer exists: |landed by hand at [0-9a-f]{12}: recorded note$|landing-repeat-v1:'
  + '|Seat [a-z]+-\\d+ has no heartbeat for two minutes or its worktree is gone; claim returned to the queue\\.$|Review silent for \\d+ minutes; its reservation lease lapsed\\.$|Lapsed claim idle past its stale interval\\.$'
  + '|(?:Released twice(?: at the \\w+ route)?: |[a-z]+-\\d+ released at the \\w+ route: )|Waiting on #\\d+, which has not landed; |Idle \\d+ minutes: no commit, file change, running check or item move since '
  + '|Stale dependency: no commit, test run or fact since |Review idle for \\d+ minutes; last observed activity )', 'u');

/** The model ids a history must never carry: a recorded run names the model that wrote the note. */
const MODEL_ID = /\b(?:claude|gpt)-/iu;

/** Every place a recorded history holds prose that is not neutral, or names a model id, as `file: path`. */
function historyProblems(name, history) {
  const found = [];
  const walk = (value, key, path) => {
    if (typeof value === 'string') {
      if (MODEL_ID.test(value)) found.push(`${name}: ${path} names a model id`);
      else if (PROSE.has(key) && !NEUTRAL.test(value) && !MECHANICAL.test(value)) found.push(`${name}: ${path} holds board text`);
    } else if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, key, `${path}[${index}]`));
    else if (value && typeof value === 'object') for (const [field, entry] of Object.entries(value)) walk(entry, field, `${path}.${field}`);
  };
  walk(history, '', '');
  return found;
}

test('moves.privacy.table-histories-hold-no-board-notes: clause 1: every table history fixture holds only the neutral placeholder in its prose fields and no model id, and a planted copy holding a coordinator note or a model id fails [C7,#11298]', () => {
  const folder = join(ROOT, 'packages/moves/tests/fixtures/table');
  const names = readdirSync(folder).filter((name) => name.endsWith('-history.json'));
  assert.ok(names.length >= 6, `the six scrubbed histories are there, found ${names.length}`);
  const problems = names.flatMap((name) => historyProblems(name, JSON.parse(readFileSync(join(folder, name), 'utf8'))));
  assert.deepEqual(problems.slice(0, 10), [], 'a history copied from a live board holds its notes; scrub them to the placeholder');
  const note = { events: [{ kind: 'note', text: 'the coordinator asked us to hold this until the merge window' }] };
  assert.deepEqual(historyProblems('planted.json', note), ['planted.json: .events[0].text holds board text']);
  assert.equal(historyProblems('planted.json', { events: [{ model: ['claude', 'opus'].join('-') }] }).length, 1, 'a model id is refused');
  assert.deepEqual(historyProblems('planted.json', { events: [{ kind: 'note', text: 'recorded note', reason: 'scrubbed reason' }] }), [], 'the placeholder passes');
});
