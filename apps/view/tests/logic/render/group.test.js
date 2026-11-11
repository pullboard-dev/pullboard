/** Cross-repository models and HTML run from supplied observations, without a page or board [N26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupActivityModel } from '../../../src/logic/render/group.js';
import { groupNeedsHtml } from '../../../src/logic/render/group.js';
import { groupEventHtml } from '../../../src/logic/render/group.js';

test('group history keeps newest eighty events and resolves each title in its own repository [N26,C7]', () => {
  const repos = [1, 2].map(index => ({ name: 'Repo ' + index, root: '/repo-' + index, board: {
    items: [{ id: 1, title: 'Title ' + index }], events: Array.from({ length: 45 }, (_, minute) => ({
      event_id: minute + 1, item_id: 1, event_at: new Date(Date.UTC(2026, 9, 28, index, minute)).toISOString(),
    })) } }));
  const before = JSON.stringify(repos), rows = groupActivityModel(repos);
  assert.equal(rows.length, 80);
  assert.equal(rows[0].repo.name, 'Repo 2');
  assert.equal(rows[0].event_id, 45);
  assert.equal(rows[0].title, 'Title 2');
  assert.equal(rows.at(-1).repo.name, 'Repo 1');
  assert.equal(rows.at(-1).event_id, 11);
  assert.equal(rows.at(-1).titles.get('1'), 'Title 1');
  assert.equal(JSON.stringify(repos), before);
});

test('group person calls preserve prepared rich text, escaped identities and their repository target [N26,B26,C7]', () => {
  const rows = [{ repoName: 'Repo <one>', repoRoot: '/repo "one"', ref: 'G1', textHtml: '<b>Prepared question</b>', actionLabel: 'answer <G1>', ageHtml: '<time>2m</time>' }];
  const html = groupNeedsHtml(rows);
  assert.match(html, /Repo &lt;one&gt;/u);
  assert.match(html, /data-root="\/repo &quot;one&quot;"/u);
  assert.match(html, /<span><b>Prepared question<\/b><\/span>/u);
  assert.match(html, /answer &lt;G1&gt;, <time>2m<\/time> →/u);
  assert.match(groupNeedsHtml([]), /Nothing needs you across this project/u);
});

test('group event links keep board scope and plain labels separate from prepared title HTML [N26,C7]', () => {
  const row = { timeLabel: '12:00', repoName: 'Repo <two>', agentLabel: 'builder & model', kind: 'claim', itemId: 1,
    itemHref: '#other/1', foreignRoot: '/other "board"', titleHtml: '<b>Prepared title</b>' };
  const html = groupEventHtml(row);
  assert.match(html, /<time>12:00<\/time>/u);
  assert.match(html, /Repo &lt;two&gt;/u);
  assert.match(html, /builder &amp; model claim/u);
  assert.match(html, /href="#other\/1" data-go="item:1" data-board="\/other &quot;board&quot;"/u);
  assert.match(html, /<b>Prepared title<\/b>/u);
  assert.doesNotMatch(groupEventHtml({ ...row, foreignRoot: null }), /data-board=/u);
  assert.doesNotMatch(groupEventHtml({ ...row, itemId: null }), /data-go=|Prepared title/u);
});
