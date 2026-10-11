/** Cockpit references checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { exportView } from '../../src/serve.js';
import { relayPresentation } from '../../src/relay-presentation.js';
import { machine, project, build, fetchLive, startView, target, openPage, boardId, chromeExecutable, openSnapshotChrome, closeSnapshotChrome } from './fixture.js';


test("a shout's code reference opens that code as it was at that commit [B23]", async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  const beta = project(box, 'beta');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  const first = box.git(alpha.web, 'rev-parse', 'HEAD');
  writeFileSync(join(alpha.web, 'web', 'greeting.html'), '  hello <b>there</b>\n    second line\n');
  writeFileSync(join(alpha.web, 'web', 'long.txt'), Array.from({ length: 100 }, (_, n) => `line ${n + 1}`).join('\n') + '\n');
  // A path with a space ends in another file's path: text that may name it must not open the other.
  writeFileSync(join(alpha.web, 'web', 'note.txt'), 'plain note\n');
  mkdirSync(join(alpha.web, 'web', 'my web'));
  writeFileSync(join(alpha.web, 'web', 'my web', 'note.txt'), 'spaced note\n');
  mkdirSync(join(alpha.web, 'web', 'one two three four five web'));
  writeFileSync(join(alpha.web, 'web', 'one two three four five web', 'note.txt'), 'longer spaced note\n');
  box.git(alpha.web, 'add', '-A');
  box.git(alpha.web, 'commit', '-q', '-m', 'feat(web): a warmer greeting [G1]');
  const second = box.git(alpha.web, 'rev-parse', 'HEAD');
  const was = `web/greeting.html:1@${first.slice(0, 7)}`;
  const now = `web/greeting.html:1-2@${second.slice(0, 12)}`;
  const long = `web/long.txt:1-100@${second}`;
  const first_ = `#1 was ${was}, is ${now}; see ${long}.`;
  box.run(alpha.web, 'shout', 'all', first_);
  box.run(alpha.web, 'fact', '1', 'note', 'review the committed greeting', '--ref', `web/greeting.html:1-2@${second}`);
  box.run(alpha.web, 'shout', 'all', 'missing commit: web/greeting.html:1@');
  box.run(alpha.web, 'shout', 'all', `missing path: :1@${second.slice(0, 7)}`);
  const spaced = `web/note.txt:1@${second.slice(0, 7)}`;
  const odd = `absolute /${was} and spaced web/my ${spaced}`;
  box.run(alpha.web, 'shout', 'all', odd);
  box.run(alpha.web, 'shout', 'all', `plus x+${spaced}`);
  box.run(alpha.web, 'shout', 'all', spaced);
  box.run(alpha.web, 'shout', 'all', `web/one two three four five ${spaced}`);
  // A file only the working tree has, which no commit holds.
  writeFileSync(join(alpha.repo, 'draft.txt'), 'not committed\n');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    // A button carries the text written before it on its line.
    // Its label: the path, then the lines and the commit's first ten characters; the whole reference on hover.
    const label = (ref) => `<span class="ref-path">${ref.slice(0, ref.indexOf(':'))}</span><span class="ref-at">${ref.slice(ref.indexOf(':'), ref.lastIndexOf('@'))}<span class="ref-sha">${ref.slice(ref.lastIndexOf('@'), ref.lastIndexOf('@') + 11)}</span></span>`;
    const button = (ref, open, before = '', block = false) => `<button class="ref${block ? ' block' : ''}" data-code="${ref}"${before ? ` data-before="${before}"` : ''} title="${ref}" aria-label="Open code reference ${ref}" type="button" aria-expanded="${open}">${label(ref)}</button>`;
    const prior = (text, ref) => text.slice(0, text.indexOf(ref));
    const [b1, b2, b3] = [was, now, long].map((ref) => prior(first_, ref));
    assert.ok(page.show('feed').includes(`#1</button> was ${button(was, false, b1)}, is ${button(now, false, b2)}; see ${button(long, false, b3)}.`), 'each reference is a button in the text');

    await page.click({ code: was, before: b1 });
    await page.click({ code: now, before: b2 });
    let feed = page.show('feed');
    assert.ok(feed.includes(button(was, true, b1) + '<div class="code-ref open">' + button(was, true, b1, true) + '<div class="code-wrap"><pre class="code"><span><i>1</i>greeting.html</span></pre></div>'), 'the code as it was at that commit');
    assert.ok(feed.includes(button(now, true, b2) + '<div class="code-ref open">' + button(now, true, b2, true) + '<div class="code-wrap"><pre class="code"><span><i>1</i>  hello &lt;b&gt;there&lt;/b&gt;</span><span><i>2</i>    second line</span></pre></div>'), 'escaped, every indent kept');

    await page.click({ code: long, before: b3 });
    feed = page.show('feed');
    const shown = feed.slice(feed.indexOf(button(long, true, b3)));
    assert.equal([...shown.matchAll(/<span><i>\d+<\/i>/g)].length, 60, 'at most sixty lines');
    assert.match(shown, /<i>60<\/i>line <span class="tok-number">60<\/span><\/span><\/pre><button class="code-control" data-code-all="/);
    await page.click({ codeAll: long, before: b3 });
    feed = page.show('feed');
    const expandedAll = feed.slice(feed.indexOf(button(long, true, b3)));
    assert.equal([...expandedAll.matchAll(/<span><i>\d+<\/i>/g)].length, 100, 'show all lines fetches every line in the cited range');
    assert.match(expandedAll, /<i>100<\/i>line <span class="tok-number">100<\/span><\/span><\/pre><button class="code-control" data-code-less="/);
    await page.click({ codeLess: long, before: b3 });
    assert.equal([...page.show('feed').slice(page.show('feed').indexOf(button(long, true, b3))).matchAll(/<span><i>\d+<\/i>/g)].length, 60, 'show less returns to the bounded first window');

    await page.run('seen = ""; refresh()');
    assert.ok(page.show('feed').includes(button(was, true, b1) + '<div class="code-ref open">' + button(was, true, b1, true) + '<div class="code-wrap">'), 'a refresh keeps it open');
    await page.click({ code: was, before: b1 });
    assert.ok(page.show('feed').includes(button(was, false, b1) + ', is'), 'a second click closes it');

    // A reference is a whole word, never the tail of one: what is no path in the repo says so, and so
    // does one the text before it may make part of a longer path, however long, rather than open
    // another file.
    const b4 = prior(odd, spaced);
    const b5 = 'web/one two three four five ';
    feed = page.show('feed');
    assert.ok(feed.includes(`absolute ${button('/' + was, false, 'absolute ')} and spaced web/my ${button(spaced, false, b4)}`));
    assert.ok(feed.includes(`plus ${button('x+' + spaced, false, 'plus ')}`));
    await page.click({ code: '/' + was, before: 'absolute ' });
    await page.click({ code: spaced, before: b4 });
    await page.click({ code: 'x+' + spaced, before: 'plus ' });
    await page.click({ code: spaced });
    await page.click({ code: spaced, before: b5 });
    feed = page.show('feed');
    assert.ok(feed.includes(button('/' + was, true, 'absolute ') + '<div class="code-ref open">' + button('/' + was, true, 'absolute ', true) + '<span class="code no" role="status">[BAD_REF] name a file inside the repo by its path from the top, such as src/serve.js (saw &quot;/web/greeting.html&quot;)</span>'), 'escaped, as every refusal');
    assert.ok(feed.includes(button('x+' + spaced, true, 'plus ') + '<div class="code-ref open">' + button('x+' + spaced, true, 'plus ', true) + '<span class="code no" role="status">[BAD_REF] name a file inside the repo by its path from the top, such as src/serve.js (saw &quot;x+web/note.txt&quot;)</span>'));
    assert.ok(feed.includes(button(spaced, true, b4) + '<div class="code-ref open">' + button(spaced, true, b4, true) + '<span class="code no" role="status">[AMBIGUOUS] the text before it may make it &quot;web/my web/note.txt&quot;, which a reference cannot name</span>'));
    assert.ok(feed.includes(button(spaced, true, b5) + '<div class="code-ref open">' + button(spaced, true, b5, true) + '<span class="code no" role="status">[AMBIGUOUS] the text before it may make it &quot;web/one two three four five web/note.txt&quot;, which a reference cannot name</span>'), 'however many words the path has');
    // Inside a block comment a line is all comment: its apostrophe is a word, not the start of a string.
    assert.deepEqual([" * the verifier's checkout", '/** Version */', ' */', '# a note'].map((line) => page.run(`highlightCodeLine(${JSON.stringify(line)}, 'src/a.js')`)),
      ["<span class=\"tok-comment\"> * the verifier&#39;s checkout</span>", '<span class="tok-comment">/** Version */</span>', '<span class="tok-comment"> */</span>', '# a note'],
      'block comment lines are comments; a hash is not one in JavaScript');
    assert.equal(page.run("highlightCodeLine('# a note', 'tools/run.py')"), '<span class="tok-comment"># a note</span>', 'but is in Python');
    // A comment or a template string that spans lines is colored on every line of it, and the code after it is code again.
    const carried = (lines) => JSON.parse(page.run(`JSON.stringify((() => { const state = {}; return ${JSON.stringify(lines)}.map((line) => highlightCodeLine(line, 'src/a.js', state)); })())`));
    assert.deepEqual(carried(['const s = \`a', "it's b", 'c\`; x', 'y']),
      ['<span class="tok-keyword">const</span> s = <span class="tok-string">\`a</span>', '<span class="tok-string">it&#39;s b</span>', '<span class="tok-string">c\`</span>; x', 'y'], 'a template string carries across lines');
    assert.deepEqual(carried(['/* open', "still it's", 'done */ const']),
      ['<span class="tok-comment">/* open</span>', '<span class="tok-comment">still it&#39;s</span>', '<span class="tok-comment">done */</span> <span class="tok-keyword">const</span>'], 'and so does a block comment');
    assert.ok(feed.includes('<div class="code-ref open">' + button(spaced, true, '', true) + '<div class="code-wrap"><pre class="code"><span><i>1</i>plain note</span></pre></div></div>'), 'a reference standing alone is a block that opens, whatever other files there are');

    const ask = async (ref, { root = alpha.repo, key = view.key, before = '' } = {}) => {
      const id = await boardId(view, root);
      const res = await fetchLive(`${view.base}/api/v1/boards/${id}/code?ref=${encodeURIComponent(ref)}&before=${encodeURIComponent(before)}`, { headers: { 'x-pullboard-key': key } });
      const result = await res.json();
      return [res.status, result.error ? `[${result.error.code}] ${result.error.message}` : ''];
    };
    assert.deepEqual(await ask(spaced, { before: 'see web/my ' }), [400, '[AMBIGUOUS] the text before it may make it "web/my web/note.txt", which a reference cannot name']);
    assert.deepEqual(await ask(spaced, { before: 'see the ' }), [200, ''], 'text that makes no file leaves it be');
    const sha = first.slice(0, 7);
    for (const ref of [`../outside.txt:1@${sha}`, `/etc/passwd:1@${sha}`, `web/../../outside.txt:1@${sha}`, `./web/greeting.html:1@${sha}`]) {
      assert.deepEqual(await ask(ref), [400, `[BAD_REF] name a file inside the repo by its path from the top, such as src/serve.js (saw "${ref.split(':')[0]}")`], `${ref} is refused`);
    }
    for (const commit of ['HEAD', 'main', '--output=x', 'abc']) assert.match((await ask(`web/greeting.html:1@${commit}`)).join(' '), /^400 \[BAD_REF\] use ref=path:lines@commit/, `${commit} is no SHA`);
    assert.deepEqual(await ask('web/greeting.html:1@deadbee'), [400, '[NO_COMMIT] no commit deadbee in this repo']);
    assert.deepEqual(await ask(`draft.txt:1@${second}`), [400, `[NO_FILE] no file draft.txt at ${second}`], 'the working tree is never read');
    assert.deepEqual(await ask(`web:1@${sha}`), [400, `[NO_FILE] no file web at ${sha}`], 'nor a folder');
    assert.deepEqual(await ask(`web/greeting.html:0@${sha}`), [400, '[BAD_REF] name the lines as 12, or 12-30']);
    assert.deepEqual(await ask(`web/greeting.html:3-2@${sha}`), [400, '[BAD_REF] name the lines as 12, or 12-30']);
    assert.deepEqual(await ask(`web/greeting.html:9@${sha}`), [400, `[NO_LINES] web/greeting.html has 1 lines at ${sha}`]);
    assert.deepEqual(await ask(`web/greeting.html:1-2@${sha}`), [400, `[NO_LINES] web/greeting.html has 1 lines at ${sha}`], 'nor lines that run past the end');
    assert.deepEqual(await ask(`web/greeting.html@${sha}`), [400, '[BAD_REF] use ref=path:lines@commit, such as src/serve.js:12-30@be4356b']);
    const unknown = await ask(was, { root: box.dir });
    assert.equal(unknown[0], 404);
    assert.match(unknown[1], /^\[NO_BOARD\]/, 'a code read can name only a registered board');
    assert.equal((await ask(was, { key: 'wrong' }))[0], 401, 'and nothing without the secret');

    // A refused reference says why where its code would be.
    box.run(alpha.web, 'shout', 'all', `gone: web/greeting.html:7@${sha}`);
    await page.run('refresh()');
    await page.click({ code: `web/greeting.html:7@${sha}`, before: 'gone: ' });
    assert.ok(page.show('feed').includes(`<span class="code no" role="status">[NO_LINES] web/greeting.html has 1 lines at ${sha}</span>`));
    assert.match(page.show('feed'), /Code reference unavailable: missing a usable commit SHA\./);
    assert.match(page.show('feed'), /Code reference unavailable: missing the repository path\./);
    assert.match(page.show('detail'), /Referenced code/);
    assert.ok(page.show('detail').includes(button(`web/greeting.html:1-2@${second}`, false)), 'typed thread refs reuse the collapsed reference block');
    const relay = JSON.stringify(relayPresentation(alpha.repo));
    assert.ok(relay.includes('"path":"web/greeting.html"') && relay.includes('"commit":"' + second + '"'), 'the relay presentation retains only the typed reference fields');
    assert.ok(!relay.includes('  hello <b>there</b>'), 'the relay presentation never contains committed source text');

    // Expansion stays attached to the repo that owned the reference if the selected project changes mid-flight.
    const alphaId = await page.run(`data.projects.find((entry) => entry.root === ${JSON.stringify(alpha.repo)}).id`);
    const betaId = await page.run(`data.projects.find((entry) => entry.root === ${JSON.stringify(beta.repo)}).id`);
    await page.run(`let expansionPaths = []; let finishFirstExpansionPage; api = (path) => { expansionPaths.push(path); if (expansionPaths.length === 1) return new Promise((resolve) => { finishFirstExpansionPage = resolve; }); return Promise.resolve({ code: { lines: Array(40).fill('line') } }); };`);
    await page.click({ codeAll: long, before: b3 });
    assert.equal(await page.run('expansionPaths.length'), 1, 'the first expansion page is held until the project changes');
    await page.run(`view.root = ${JSON.stringify(beta.repo)}; finishFirstExpansionPage({ code: { lines: Array(60).fill('line') } });`);
    for (let turn = 0; turn < 6; turn++) await new Promise((resolve) => setImmediate(resolve));
    const expansionPaths = JSON.parse(await page.run('JSON.stringify(expansionPaths)'));
    assert.equal(expansionPaths.length, 2, 'the two-page range completes');
    assert.ok(expansionPaths.every((path) => path.startsWith('/api/v1/boards/' + encodeURIComponent(alphaId) + '/code?')), 'later pages remain bound to the reference project');
    assert.ok(!expansionPaths.some((path) => path.startsWith('/api/v1/boards/' + encodeURIComponent(betaId) + '/code?')), 'project switching does not redirect a pending code read');
    const wideRange = `web/long.txt:1-10001@${second}`;
    await page.run(`view.root = ${JSON.stringify(alpha.repo)}; view.code[${JSON.stringify(alpha.repo + '\n\n' + wideRange)}] = { open: true, path: 'web/long.txt', from: 1, lines: Array(60).fill('line'), more: true }; let wideCalls = 0; api = () => { wideCalls++; return Promise.resolve({ code: { lines: Array(wideCalls < 167 ? 60 : 41).fill('line') } }); };`);
    await page.click({ codeAll: wideRange });
    for (let turn = 0; turn < 6; turn++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await page.run('wideCalls'), 167, 'show all keeps working beyond the former arbitrary 10,000-line cap');
    assert.equal(await page.run(`view.code[${JSON.stringify(alpha.repo + '\n\n' + wideRange)}].allLines.length`), 10001);
  } finally {
    await view.stop();
  }
});

test('committed shout and fact references stay local, expand safely at phone and desktop widths, and explain relay snapshots [N26,B33]', { timeout: 180_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run code-reference viewport checks.');
  const box = machine();
  const alpha = project(box, 'local-code');
  box.run(alpha.repo, 'add', 'web', 'Referenced source', '--specs', 'G1');
  mkdirSync(join(alpha.web, 'web'), { recursive: true });
  const sourceText = ['const localOnlyFixture = 42;', ...Array.from({ length: 99 }, (_, index) => `export const row${index + 1} = ${index + 1};`)].join('\n') + '\n';
  writeFileSync(join(alpha.web, 'web', 'reference.js'), sourceText);
  build(box, alpha, 1, 'submitted.txt');
  const sha = box.git(alpha.web, 'rev-parse', 'HEAD');
  const ref = `web/reference.js:1-100@${sha}`;
  box.run(alpha.web, 'fact', '1', 'note', 'review the source block', '--ref', ref);
  box.run(alpha.web, 'shout', 'all', `source: ${ref}`);
  box.run(alpha.web, 'shout', 'all', 'missing commit: web/reference.js:1@deadbee');
  box.run(alpha.web, 'shout', 'all', `missing path: :1@${sha.slice(0, 7)}`);

  const presentation = JSON.stringify(relayPresentation(alpha.repo));
  assert.ok(presentation.includes('"path":"web/reference.js"') && presentation.includes('"commit":"' + sha + '"'), 'relay projection carries the typed reference');
  assert.ok(!presentation.includes('localOnlyFixture') && !presentation.includes('row99'), 'relay projection contains no source code');

  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'local-code-chrome'));
    await chrome.waitFor('typeof data === "object" && data?.project?.shouts?.length >= 3 && data?.project?.items?.[0]?.thread?.some((entry) => entry.type === "fact" && entry.ref)');
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      await chrome.evaluate(`document.querySelector('[data-tab="shouts"]').click()`);
      await chrome.evaluate(`document.querySelector('#feed button[data-code^="web/reference.js:1-100@"]').click()`);
      await chrome.waitFor(`document.querySelector('#feed .code-wrap pre.code .tok-keyword')?.textContent === 'const'`);
      assert.equal(await chrome.evaluate(`document.querySelector('#feed pre.code').textContent.includes('localOnlyFixture = 42')`), true, 'the open local preview reads the exact committed text');
      assert.equal(await chrome.evaluate(`document.querySelector('#feed pre.code .tok-number')?.textContent`), '42', 'source tokens receive syntax highlighting');
      assert.equal(await chrome.evaluate(`document.querySelectorAll('#feed pre.code > span').length`), 60, 'the initial preview stays bounded');
      await chrome.evaluate(`document.querySelector('#feed button[data-code-all]').click()`);
      await chrome.waitFor(`document.querySelectorAll('#feed pre.code > span').length === 100`);
      assert.equal(await chrome.evaluate(`document.querySelector('#feed pre.code > span:last-child').textContent.includes('row99 = 99')`), true, 'show all lines fetches the end of the cited range');
      await chrome.evaluate(`document.querySelector('#feed button[data-code-less]').click()`);
      await chrome.waitFor(`document.querySelectorAll('#feed pre.code > span').length === 60`);
      assert.equal(await chrome.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, `${width}px page has no sideways overflow`);

      assert.equal(await chrome.evaluate(`!!document.querySelector('#detail .fact-code .code-ref:not(.open) > button.ref.block[aria-expanded="false"]')`), true, 'a fact\'s reference is a collapsed block too');
      await chrome.evaluate(`document.querySelector('#detail .fact-code button[data-code]').click()`);
      await chrome.waitFor(`document.querySelector('#detail .fact-code pre.code .tok-keyword')?.textContent === 'const'`);
      assert.equal(await chrome.evaluate(`document.querySelector('#detail .fact-code pre.code').textContent.includes('localOnlyFixture = 42')`), true, 'typed fact refs use the same local renderer');
      assert.equal(await chrome.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, `${width}px thread ref has no sideways overflow`);
      await chrome.evaluate(`document.querySelector('#detail .fact-code button[data-code]').click()`);
      await chrome.evaluate(`document.querySelector('#feed button[data-code^=\"web/reference.js:1-100@\"]').click()`);
      await chrome.waitFor(`document.querySelector('#feed button[data-code^=\"web/reference.js:1-100@\"]').getAttribute('aria-expanded') === 'false'`);
    }
    await chrome.evaluate(`document.querySelector('#feed button[data-code^="web/reference.js:1@deadbee"]').click()`);
    await chrome.waitFor(`document.querySelector('#feed button[data-code^=\"web/reference.js:1@deadbee\"] + .code-ref .code, #feed button[data-code^=\"web/reference.js:1@deadbee\"] + .code')?.textContent.includes('[NO_COMMIT]')`);
    assert.equal(await chrome.evaluate(`document.querySelector('#feed button[data-code^=\"web/reference.js:1@deadbee\"] + .code-ref .code, #feed button[data-code^=\"web/reference.js:1@deadbee\"] + .code').textContent.includes('deadbee')`), true, 'a missing commit produces its readable refusal');
    assert.equal(await chrome.evaluate(`document.querySelector('#feed .ref-missing')?.textContent.includes('missing the repository path')`), true, 'a reference with no path gives a clear note');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }

  const snapshotDir = mkdtempSync(join(box.dir, 'relay-snapshot-'));
  const exported = await exportView(alpha.repo, snapshotDir);
  const exportedFiles = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path); else exportedFiles.push(readFileSync(path, 'utf8'));
    }
  };
  walk(exported.path);
  assert.ok(exportedFiles.join('\n').includes('web/reference.js:1-100@' + sha), 'static relay view retains the reference');
  assert.ok(!exportedFiles.join('\n').includes('localOnlyFixture'), 'the static relay artifact never contains the source text');
  const snapshotServer = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
    const target = resolve(exported.path, relativePath);
    if (!target.startsWith(resolve(exported.path) + '/') || !existsSync(target)) { response.writeHead(404).end(); return; }
    const type = target.endsWith('.css') ? 'text/css; charset=utf-8' : target.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(readFileSync(target));
  });
  await new Promise((resolve) => snapshotServer.listen(0, '127.0.0.1', resolve));
  let snapshotChrome;
  try {
    const address = snapshotServer.address();
    snapshotChrome = await openSnapshotChrome(executable, `http://127.0.0.1:${address.port}/`, join(box.dir, 'relay-snapshot-chrome'));
    await snapshotChrome.waitFor(`document.querySelector('#feed button[data-code^=\"web/reference.js:1-100@\"]')`);
    await snapshotChrome.evaluate(`document.querySelector('[data-tab="shouts"]').click()`);
    await snapshotChrome.evaluate(`document.querySelector('#feed button[data-code^="web/reference.js:1-100@"]').click()`);
    await snapshotChrome.waitFor(`document.querySelector('#feed button[data-code^=\"web/reference.js:1-100@\"]')?.getAttribute('aria-expanded') === 'true'`);
    assert.match(await snapshotChrome.evaluate(`document.querySelector('#feed button[data-code^=\"web/reference.js:1-100@\"] + .code-ref .code, #feed button[data-code^=\"web/reference.js:1-100@\"] + .code')?.textContent || ''`), /Source code is not included in this relay snapshot/);
    assert.ok(snapshotChrome.requests.every((request) => !request.url.includes('/code?')), 'relay snapshot serves only the reference and sends no code read');
  } finally {
    if (snapshotChrome) await closeSnapshotChrome(snapshotChrome);
    await new Promise((resolve) => snapshotServer.close(resolve));
  }
});
