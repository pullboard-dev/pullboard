/** The hosted sidebar renders one group per machine name with its boards, local and relay together [N26,H5]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostedSidebarHtml } from '../../src/logic/hosted-sidebar.js';
import { mergeBoards } from '../../src/logic/hosted.js';

test('view.x-hosted-sidebar.clause-1-the-hosted-sidebar-renders-one-group-per-machine: clause 1: the hosted sidebar renders one group per machine name with its boards, local and relay together [N26]', () => {
  const local = { machine: 'Tower', here: true, boards: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }] };
  const relay = [{ machine: 'Tower', boards: [{ id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma <x>' }] }, { machine: 'Laptop', boards: [{ id: 'd', name: 'Delta' }] }];
  const html = hostedSidebarHtml(mergeBoards(local, relay));
  assert.equal([...html.matchAll(/<section class="side-machine"/gu)].length, 2);
  assert.match(html, /data-machine="Tower"><h3>this computer<\/h3><ul><li data-board="a">Alpha<\/li><li data-board="b">Beta<\/li><li data-board="c">Gamma &lt;x&gt;<\/li><\/ul>/u);
  assert.match(html, /data-machine="Laptop"><h3>Laptop<\/h3><ul><li data-board="d">Delta<\/li><\/ul>/u);
  assert.equal(hostedSidebarHtml([]), '');
});
