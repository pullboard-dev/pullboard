/** @pullboard-test-input source-cell apps/view */
/** Cockpit hosted page script checks, split from cockpit.test.js [N26,B26,C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { pageScriptPart4 } from '../../../../view/index.js';
import { readPathMap } from '../../../../../packages/codemap/index.js';
import { REPOSITORY } from '../../../tests/fixtures/source.js';

/** Return regex-literal bodies while skipping comments and quoted strings in a hosted script part. */
function regexLiterals(source) {
  const found = [];
  let quote = '', comment = '', canStart = true;
  for (let i = 0; i < source.length;) {
    const c = source[i], next = source[i + 1];
    if (comment === 'line') { if (c === '\n') comment = ''; i++; continue; }
    if (comment === 'block') { if (c === '*' && next === '/') { comment = ''; i += 2; } else i++; continue; }
    if (quote) { if (c === '\\') i += 2; else { if (c === quote) quote = ''; i++; } continue; }
    if (c === '/' && next === '/') { comment = 'line'; i += 2; continue; }
    if (c === '/' && next === '*') { comment = 'block'; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; canStart = false; i++; continue; }
    if (c === '/' && canStart) {
      let body = '', j = i + 1, escaped = false, inClass = false;
      for (; j < source.length; j++) {
        const x = source[j];
        if (!escaped && x === '[') inClass = true;
        if (!escaped && x === ']') inClass = false;
        if (!escaped && x === '/' && !inClass) break;
        body += x;
        if (!escaped && x === '\\') escaped = true; else escaped = false;
      }
      if (j < source.length) { found.push({ body, index: i }); i = j + 1; while (/[a-z]/i.test(source[i] || '')) i++; canStart = false; continue; }
    }
    canStart = /[([{,:;=!?&|+*%^~<>-]/.test(c);
    if (!/\s/.test(c)) i++; else i++;
  }
  return found;
}

test('cli.journeys-spec-cockpit-script.no-hosted-page-script-part-loses: no hosted page script part loses a regex backslash [N26]', () => {
  const offenders = [];
  // The four hosted page script parts were src/view/page-script-N.js; the path map says where each lives now.
  const parts = [...readPathMap(REPOSITORY)].filter(([from]) => /^src\/view\/page-script-\d+\.js$/u.test(from));
  assert.equal(parts.length, 4, 'the map names all four hosted page script parts');
  for (const [, file] of parts) {
    const source = readFileSync(join(REPOSITORY, file), 'utf8');
    const start = source.indexOf('return `') + 'return `'.length;
    const body = source.slice(start, source.lastIndexOf('`;'));
    for (const literal of regexLiterals(body)) {
      if (/(?<!\\)\\[sdwbSDWBrn]/u.test(literal.body)) {
        const line = body.slice(0, literal.index).split('\n').length + 10;
        offenders.push(`${file}:${line}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `hosted regex escapes need a doubled template-literal backslash: ${offenders.join(', ')}`);
});

test('cli.journeys-spec-cockpit-script.emitted-page-script-splits-decision-ids: emitted page script splits decision ids on whitespace [N26]', () => {
  const served = pageScriptPart4({});
  const split = /String\(args\.ids\)\.split\((\/.*?\/)\)/u.exec(served);
  assert.ok(split, 'the served decideRow implementation splits its ids');
  const ids = Function(`return String('G1 G2').split(${split[1]})`)();
  assert.deepEqual(ids, ['G1', 'G2'], 'the emitted page script gives decideRow two row ids');
  const rows = ['spec:G0', 'spec:G1', 'spec:G2', 'spec:G3'];
  const next = rows.slice(rows.findIndex((row) => row === `spec:${ids[0]}`) + 1).find((row) => !ids.includes(row.slice('spec:'.length)));
  assert.equal(next, 'spec:G3', 'after deciding G1 and G2, the next undecided row is G3');
  assert.equal(ids.map((id) => `doctrine:${id}`).join(' '), 'doctrine:G1 doctrine:G2', 'each doctrine row keeps its own qualified id');
});

test('cli.journeys-spec-cockpit-script.a-decision-on-two-spec-rows: a decision on two spec rows splits their ids on whitespace [B26,N26]', async () => {
  const served = pageScriptPart4({});
  const start = served.indexOf('async function decideRow(');
  const end = served.indexOf('\n}\n', start) + 2;
  assert.ok(start >= 0 && end > start, 'the test extracts the production decideRow from the served page script');
  const window = { scrollY: 275, scrolls: [], scrollTo(position) { this.scrolls.push(position); } };
  const rowsFor = (kind, ids) => ids.map((id) => ({ dataset: { row: `${kind}:${id}` }, getBoundingClientRect: () => ({ top: 20, bottom: 40 }), scrollIntoView() { throw Error('the next row is already visible'); } }));
  let rows = rowsFor('spec', ['G0', 'G1', 'G2', 'G3']);
  const moves = [];
  const view = { root: 'repo', row: { spec: 'G1', doctrine: 'D1' } };
  const context = {
    snapshot: false, readOnly: false, requests: false, view, window, innerHeight: 900,
    $: (id) => ({ querySelectorAll: () => id === 'spec-list' ? rows : rowsFor('doctrine', ['D1', 'D2', 'D3']) }),
    render() {}, setTimeout() {},
    pageMove: (command, args) => ({ body: { command, args } }),
    boardPath: () => '/moves', api: async (path, body) => { moves.push(body); return { result: {} }; },
    moveMessage: () => 'recorded', refresh: async () => {},
  };
  const decideRow = vm.runInNewContext(`(${served.slice(start, end)})`, context);
  const anchor = { closest: () => null };
  assert.equal(await decideRow('spec', 'spec-approve', { ids: 'G1 G2' }, anchor), true);
  assert.equal(view.row.spec, 'G3', 'the next pick skips both decided rows and keeps the reading position');
  assert.equal(moves[0].args.ids, 'G1 G2', 'the hosted page sends the two spec ids');
  assert.deepEqual(JSON.parse(JSON.stringify(window.scrolls)), [{ top: 275, behavior: 'instant' }, { top: 275, behavior: 'instant' }], 'the page restores the original scroll position');
  rows = rowsFor('doctrine', ['D1', 'D2', 'D3']);
  assert.equal(await decideRow('doctrine', 'spec-approve', { ids: 'D1 D2' }, anchor), true);
  assert.equal(view.row.doctrine, 'D3', 'the doctrine pick advances past both decided rows');
  assert.equal(moves[1].args.ids, 'doctrine:D1 doctrine:D2', 'each doctrine id receives its own prefix in the outgoing move');
});

