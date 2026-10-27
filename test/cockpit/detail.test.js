/** @pullboard-test-gui */
/** Cockpit item detail checks: lists from summaries, detail on demand, using the shared real-board fixtures [N26,A2]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { machine, project, build, sendBack, accept, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, press, searchFor, chooseFilter, serveFolder } from './fixture.js';

/**
 * Before the page loads, keep a count of its API reads, start it on the Shouts tab once, and let the
 * test hold item detail reads, so the loading line can be seen and released.
 */
const OBSERVE = `(() => {
  const nativeFetch = window.fetch.bind(window), held = [];
  window.__pbReads = [];
  window.__pbHold = false;
  window.__pbRelease = () => { window.__pbHold = false; while (held.length) held.shift()(); };
  window.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    window.__pbReads.push(url.pathname + url.search);
    if (window.__pbHold && /\\/items\\/\\d+$/.test(url.pathname)) return new Promise((go) => held.push(go)).then(() => nativeFetch(input, init));
    return nativeFetch(input, init);
  };
  try { if (!localStorage.getItem('pb.tab')) localStorage.setItem('pb.tab', 'shouts'); } catch {}
})()`;

/** The item detail and search reads among a page's API reads, in order. */
const itemReads = (reads) => reads.filter((path) => /\/api\/v1\/boards\/[^/]+\/items(\/|\?|$)/.test(path))
  .map((path) => path.replace(/^.*\/items/, 'items'));

/** What the detail pane shows of an item: its heading, criterion, check, brief, verdicts, moves and facts. */
const DETAIL = `(() => {
  const detail = document.querySelector('#detail');
  const part = (name) => [...detail.querySelectorAll('h3')].find((heading) => heading.textContent === name)?.parentElement;
  return {
    title: detail.querySelector('h2')?.innerText ?? null,
    waiting: detail.querySelector('.detail-wait')?.textContent ?? null,
    busy: !!detail.querySelector('[aria-busy]'),
    criterion: part('Criterion')?.querySelector('.text').innerText ?? null,
    check: part('Check') ? [part('Check').querySelector('code').textContent, part('Check').querySelector('.chip').textContent] : null,
    brief: part('Brief')?.querySelector('.text').innerText ?? null,
    verdicts: [...detail.querySelectorAll('.verdict')].map((verdict) => [verdict.classList.contains('yes') ? 'ACCEPT' : 'REJECT', verdict.querySelector('.note').innerText]),
    moves: [...detail.querySelectorAll('.tl > li:not(.tl-fact) b')].map((move) => move.textContent),
    facts: [...detail.querySelectorAll('.tl > .tl-fact .tl-body')].map((fact) => fact.textContent),
  };
})()`;

test('opening an item loads its detail on demand [N26,A2]', { timeout: 150_000 }, // budget: hang-only ceiling for one live view and one export in a single Chrome, with two board polls.
  async () => {
    const executable = chromeExecutable();
    assert.ok(executable, 'Chrome is required to open items in the view');
    const box = machine();
    const alpha = project(box, 'detail-demand');
    box.run(alpha.repo, 'add', 'web', 'Offline greeting', '--specs', 'G1', '--criterion', 'The greeting renders from the snapshot alone.', '--brief', 'Keep the greeting short.', '--check', 'true', '--wait');
    box.run(alpha.repo, 'add', 'web', 'Farewell page', '--specs', 'G1', '--criterion', 'The farewell mentions the zeppelin.');
    box.run(alpha.repo, 'add', 'web', 'Footer', '--specs', 'G1', '--criterion', 'The footer renders.');
    build(box, alpha, 1, 'greeting.html');
    sendBack(box, alpha, 1, 'the first greeting needs a correction');
    box.run(alpha.web, 'fact', '1', 'measurement', 'The corrected greeting renders offline.');
    build(box, alpha, 1, 'greeting-fix.html');
    accept(box, alpha, 1);
    build(box, alpha, 2, 'farewell.html');
    box.run(alpha.repo, 'milestone', 'add', 'Launch', '--items', '1,2');

    const view = await startView(box);
    let chrome, host;
    try {
      chrome = await openSnapshotChrome(executable, 'about:blank', join(box.dir, 'detail-chrome'));
      await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVE });
      await chrome.send('Page.navigate', { url: view.link.href });
      await chrome.waitFor("typeof data === 'object' && !!data?.project && document.querySelectorAll('#chain .row').length === 2 && document.querySelectorAll('#roadmap .milestone-item').length === 2");

      // The page starts on Shouts. Its lists, roadmap and counts are drawn from summaries, with no item read.
      const listed = await chrome.stable(`({
        tab: view.tab,
        summaries: data.project.items.every((item) => !('history' in item) && !('criterion' in item) && !('thread' in item)),
        rows: [...document.querySelectorAll('#chain .row')].map((row) => row.dataset.item),
        roadmap: [...document.querySelectorAll('#roadmap .milestone-item')].map((row) => row.querySelector('.id').textContent + ' ' + row.querySelector('.chip').textContent),
        reads: window.__pbReads,
      })`);
      assert.equal(listed.tab, 'shouts');
      assert.equal(listed.summaries, true, 'the view sends item summaries: no history, criterion or thread');
      assert.deepEqual(listed.rows.sort(), ['2', '3'], 'the Active list shows the submitted and the open item');
      assert.deepEqual([...listed.roadmap].sort(), ['#1 accepted', '#2 to verify'], 'the roadmap reads every member and its exact state from summaries');
      // Shipping groups follow the approved legend order, independently of item IDs or milestone membership order.
      const group = { accepted: 0, 'to verify': 1, building: 2, unclaimed: 3, 'sent back': 3, held: 4, verified: 5 };
      const ranks = listed.roadmap.map((row) => group[row.slice(row.indexOf(' ') + 1)]);
      assert.ok(ranks.every((rank, index) => Number.isInteger(rank) && (!index || ranks[index - 1] <= rank)), `the roadmap groups accepted, review, building, waiting, held, then landed: ${JSON.stringify(listed.roadmap)}`);
      assert.deepEqual(itemReads(listed.reads), [], 'the list renders with no item detail fetched');

      // Search asks the API, which matches the criterion the summaries leave out, and its result opens the item.
      await chrome.stable('window.__pbHold = true');
      await searchFor(chrome, 'zeppelin', 15_000); // budget: hang-only ceiling for one search answer from the local view.
      await chrome.waitFor("!!document.querySelector('#find-results [data-find=\"item:2\"]')");
      assert.deepEqual(itemReads(await chrome.stable('window.__pbReads')), ['items?q=zeppelin'], 'the search sends its words to the API once');
      await press(chrome, "document.querySelector('#find-results [data-find=\"item:2\"]')");
      await chrome.waitFor("view.tab === 'items' && view.item === 2 && !!document.querySelector('#detail [aria-busy] h2')");
      const waiting = await chrome.stable(DETAIL);
      assert.equal(waiting.waiting, null, 'no loading line shows while the detail is on its way');
      assert.match(waiting.title, /#2\s*Farewell page/u, 'the item paints its heading from its summary at once');
      assert.equal(waiting.criterion, null, 'the omitted fields wait for the detail');
      await chrome.stable('window.__pbRelease()');
      await chrome.waitFor("view.item === 2 && !document.querySelector('#detail [aria-busy]') && !!document.querySelector('#detail .tl')");
      const farewell = await chrome.stable(DETAIL);
      assert.equal(farewell.criterion, 'The farewell mentions the zeppelin.');
      assert.deepEqual(farewell.moves, ['add', 'claim', 'proof-run', 'submit']);
      assert.deepEqual(itemReads(await chrome.stable('window.__pbReads')), ['items?q=zeppelin', 'items/2'], 'opening an item makes exactly one detail request');

      // The verified item opens with its criterion, check, brief, verdicts and thread from one more request.
      await chrome.stable("(() => { const q = document.querySelector('#q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); q.blur(); })()");
      await chooseFilter(chrome, 'state:all');
      await press(chrome, "document.querySelector('#chain .row[data-item=\"1\"]')");
      await chrome.waitFor("view.item === 1 && !document.querySelector('#detail [aria-busy]') && !!document.querySelector('#detail .tl')");
      const greeting = await chrome.stable(DETAIL);
      assert.equal(greeting.waiting, null, 'the detail has arrived');
      delete greeting.waiting; delete greeting.busy;
      assert.deepEqual(greeting, {
        title: '#1Offline greeting',
        criterion: 'The greeting renders from the snapshot alone.',
        check: ['true', 'green'],
        brief: 'Keep the greeting short.',
        verdicts: [['REJECT', 'the first greeting needs a correction'], ['ACCEPT', 'the page shows it']],
        moves: ['add', 'claim', 'proof-run', 'proof-run', 'submit', 'reject', 'claim', 'proof-run', 'proof-run', 'submit', 'proof-run', 'accept'],
        facts: ['The corrected greeting renders offline.'],
      }, 'the detail carries what the summary leaves out');
      assert.deepEqual(itemReads(await chrome.stable('window.__pbReads')), ['items?q=zeppelin', 'items/2', 'items/1']);

      // Reopening an item, and refreshes while the board changes elsewhere, ask for nothing more.
      await press(chrome, "document.querySelector('#chain .row[data-item=\"2\"]')");
      await chrome.waitFor("view.item === 2 && document.querySelector('#detail h2')?.innerText.includes('Farewell page') && !!document.querySelector('#detail .tl')");
      const states = await chrome.stable("window.__pbReads.filter((path) => /\\/state(\\?|$)/.test(path)).length");
      box.run(alpha.web, 'claim', '3');
      await chrome.waitFor(`window.__pbReads.filter((path) => /\\/state(\\?|$)/.test(path)).length > ${states} && !!document.querySelector('#chain .row[data-item="3"] .chip.busy')`, 15_000); // budget: hang-only ceiling for the page's 3-second board poll.
      assert.deepEqual(itemReads(await chrome.stable('window.__pbReads')), ['items?q=zeppelin', 'items/2', 'items/1'], 'a refresh does not refetch items that have not changed');

      // A change to the opened item asks for its detail once more.
      box.run(alpha.repo, 'fact', '2', 'note', 'The farewell was checked after it opened.');
      await chrome.waitFor("[...document.querySelectorAll('#detail .tl-fact .tl-body')].some((fact) => fact.textContent === 'The farewell was checked after it opened.')", 15_000); // budget: hang-only ceiling for the page's 3-second board poll and one detail read.
      assert.deepEqual(itemReads(await chrome.stable('window.__pbReads')), ['items?q=zeppelin', 'items/2', 'items/1', 'items/2'], 'only the changed item is read again');

      // The pipeline counts each stage from the summaries, with no further read.
      await press(chrome, "document.querySelector('[data-items-view=\"pipeline\"]')");
      await chrome.waitFor("!!document.querySelector('#pipeline [data-stage-count=\"open\"]')");
      const stages = await chrome.stable("Object.fromEntries([...document.querySelectorAll('#pipeline [data-stage-count]')].map((count) => [count.dataset.stageCount, count.textContent]))");
      assert.deepEqual(stages, { open: '0', claimed: '1', submitted: '1', accepted: '1', merged: '0' });
      assert.deepEqual(itemReads(await chrome.stable('window.__pbReads')), ['items?q=zeppelin', 'items/2', 'items/1', 'items/2']);
      assert.deepEqual(chrome.exceptions, [], 'the live view opens items without browser exceptions');
      await view.stop();

      // An export holds every item in full: it opens an item and searches its criteria offline, asking nothing.
      const folder = join(box.dir, 'detail-export');
      box.run(alpha.repo, 'view', '--export', folder);
      host = await serveFolder(folder, '/demo/');
      await chrome.send('Page.navigate', { url: `${host.base}/demo/#items/1` });
      await chrome.waitFor("document.body.classList.contains('snapshot') && !!data?.project && snapshotReplay.index === snapshotReplay.events.length && view.item === 1 && !!document.querySelector('#detail .tl')");
      const exported = await chrome.stable(DETAIL);
      assert.equal(exported.criterion, 'The greeting renders from the snapshot alone.');
      assert.deepEqual(exported.verdicts, [['REJECT', 'the first greeting needs a correction'], ['ACCEPT', 'the page shows it']]);
      assert.deepEqual(exported.facts, ['The corrected greeting renders offline.']);
      await searchFor(chrome, 'zeppelin', 15_000); // budget: hang-only ceiling for a search the page answers itself.
      await chrome.waitFor("!!document.querySelector('#find-results [data-find=\"item:2\"]')");
      assert.deepEqual(itemReads(await chrome.stable('window.__pbReads')), [], 'the export asks for no item detail or search');
      assert.deepEqual(host.requests.filter((request) => request.path.includes('/items') || request.status !== 200), [],
        'every export request is one of its own files');
      assert.deepEqual(chrome.exceptions, [], 'the export opens items without browser exceptions');
    } finally {
      if (chrome) await closeSnapshotChrome(chrome);
      await host?.close();
      await view.stop();
    }
  });


test('a failed criterion-only search can be retried without changing the board [N26,A2]', { timeout: 150_000 }, // budget: hang-only ceiling for one live view and one real Chrome search retry.
  async () => {
    const executable = chromeExecutable();
    assert.ok(executable, 'Chrome is required to retry a criterion-only search');
    const box = machine();
    const alpha = project(box, 'detail-search-retry');
    box.run(alpha.repo, 'add', 'web', 'A searchable item', '--specs', 'G1', '--criterion', 'The moonstone appears only in this criterion.');

    const view = await startView(box);
    let chrome;
    try {
      chrome = await openSnapshotChrome(executable, 'about:blank', join(box.dir, 'detail-search-retry-chrome'));
      await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
        const nativeFetch = window.fetch.bind(window);
        window.__pbSearchAttempts = [];
        window.__pbFirstSearchFailureParsed = false;
        window.__pbFailSearchOnce = true;
        window.fetch = async (input, init) => {
          const url = new URL(typeof input === 'string' ? input : input.url, location.href);
          if (/\\/api\\/v1\\/boards\\/[^/]+\\/items$/.test(url.pathname) && url.searchParams.has('q')) {
            window.__pbSearchAttempts.push(url.pathname + url.search);
            const response = await nativeFetch(input, init);
            if (window.__pbFailSearchOnce) {
              window.__pbFailSearchOnce = false;
              const failed = new Response(JSON.stringify({ error: { code: 'TEMPORARY_SEARCH_FAILURE', message: 'temporary fixture failure' } }), {
                status: 503,
                headers: { 'content-type': 'application/json' },
              });
              const readJson = failed.json.bind(failed);
              failed.json = async () => {
                const value = await readJson();
                window.__pbFirstSearchFailureParsed = true;
                return value;
              };
              return failed;
            }
            return response;
          }
          return nativeFetch(input, init);
        };
      })()` });
      await chrome.send('Page.navigate', { url: view.link.href });
      await chrome.waitFor("typeof data === 'object' && !!data?.project && document.querySelectorAll('#chain .row').length === 1");
      const boardBefore = await chrome.stable(`JSON.stringify(data.project.items.map((item) => ({ id: item.id, title: item.title, status: item.status, updatedAt: item.updatedAt })))`);

      await searchFor(chrome, 'moonstone', 15_000); // budget: hang-only ceiling for the first search response.
      await chrome.waitFor('window.__pbFirstSearchFailureParsed === true');
      assert.equal(await chrome.stable("[...document.querySelectorAll('#find-results [data-find]')].filter((node) => node.dataset.find.startsWith('item:')).length"), 0,
        'the first API response fails and the criterion-only match is not shown');
      assert.equal(await chrome.stable('window.__pbSearchAttempts.length'), 1, 'the first query made one real local API request');
      // Let the rejected API promise and its retry-cache cleanup finish before issuing the same query again.
      await chrome.stable('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await chrome.stable("(() => { const q = document.querySelector('#q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); })()");

      await searchFor(chrome, 'moonstone', 15_000); // budget: hang-only ceiling after the retry is synchronously counted.
      const attempts = await chrome.stable('window.__pbSearchAttempts.length');
      assert.equal(attempts, 2, 'the same query starts a second API request after the first one failed');
      await chrome.waitFor("[...document.querySelectorAll('#find-results [data-find]')].some((node) => node.dataset.find === 'item:1')");
      const result = await chrome.stable(`JSON.stringify({
        attempts: window.__pbSearchAttempts,
        board: data.project.items.map((item) => ({ id: item.id, title: item.title, status: item.status, updatedAt: item.updatedAt })),
        hit: document.querySelector('#find-results [data-find="item:1"]')?.textContent.trim() ?? null,
      })`);
      const parsed = JSON.parse(result);
      assert.equal(parsed.attempts[1], parsed.attempts[0], 'retry repeats the identical criterion-only search URL');
      assert.match(parsed.attempts[0], /\/items\?q=moonstone$/u);
      assert.deepEqual(parsed.board, JSON.parse(boardBefore), 'search and retry leave the board state unchanged');
      assert.match(parsed.hit, /A searchable item/u);
      assert.deepEqual(chrome.exceptions, [], 'the failed search can be retried without a browser exception');
      await view.stop();
    } finally {
      if (chrome) await closeSnapshotChrome(chrome);
      await view.stop();
    }
  });
