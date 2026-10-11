/** Cockpit prose checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { PULLBOARD_COMMANDS } from '../../src/cockpit.js';
import { HELP } from '../../src/cli.js';
import { fetchFresh } from '../http-fixture.js';
import { relayClientFixture } from '../relay-client-fixture.js';
import { machine, project, startView, openPage, chromeExecutable, openSnapshotChrome, closeSnapshotChrome } from './fixture.js';

test('a pullboard command in prose chips only the command [N26]', async () => {
  // The page's command list is the CLI's: every "pullboard ..." that help --all prints (HELP.all) or a usage line
  // declares, choices in [a|b] or a|b, and commands after " | ", and nothing else.
  const declared = new Set();
  const read = (text) => {
    // Usage alternatives may follow an argument: spec approve <ids> | decline <ids>.
    for (const branch of text.matchAll(/pullboard ((?:[a-z-]+ )+)(?:<[^>]+> )?\| ([a-z-]+)/g)) {
      const shared = branch[1].trim().split(' ').slice(0, -1);
      read('pullboard ' + [...shared, branch[2]].join(' '));
    }
    for (const found of text.matchAll(/(?:^|[\s(`'"])pullboard ((?:\S+ ?)+?)(?= {2}|$|[;,.)](?:\s|$))/gm)) {
      const tokens = found[1].trim().split(' ');
      const phrase = [];
      for (let n = 0; n < tokens.length; n++) {
        const token = tokens[n];
        if (/^[a-z][a-zA-Z-]*$/.test(token)) { phrase.push(token); continue; }
        const choices = /^\[?([a-z][a-zA-Z-]*(?:\|[a-z][a-zA-Z-]*)+)\]?$/.exec(token);
        if (choices) for (const choice of choices[1].split('|')) declared.add([...phrase, choice].join(' '));
        else if (token === '|' && phrase.length === 1) {
          for (let k = n + 1; k < tokens.length; k += 2) { if (!/^[a-z][a-zA-Z-]*$/.test(tokens[k])) break; declared.add(tokens[k]); if (tokens[k + 1] !== '|') break; }
        }
        break;
      }
      if (phrase.length) declared.add(phrase.join(' '));
    }
  };
  read(HELP.all);
  for (const name of Object.keys(HELP.commands)) declared.add(name);
  for (const row of Object.values(HELP.commands)) for (const usage of row.usages) read(usage);
  for (const sub of ['milestone add', 'relay tokens', 'spec approve', 'prompt review']) assert.ok(declared.has(sub), `help --all declares ${sub}`);
  assert.deepEqual([...PULLBOARD_COMMANDS].sort(), [...declared].sort(), 'the view chips exactly the commands the CLI declares');
  assert.deepEqual(PULLBOARD_COMMANDS, [...PULLBOARD_COMMANDS].sort((a, b) => b.split(' ').length - a.split(' ').length), 'longest phrases first, so spec check wins over spec');

  const box = machine();
  const demo = project(box, 'commands');
  box.run(demo.repo, 'shout', 'all', [
    'pullboard spec check prints a line for docs/api.md with 0 errors.',
    'pullboard view serves every board.',
    'Run pullboard next --verify 235 then review it.',
    'pullboard verify 235 reject goes on in words.',
    'Turn pullboard relay on now, and pullboard hold web --reason "a pause" after that.',
    "pullboard's own page has no command.",
    'Then pullboard milestone add Launch for the person, and pullboard prompt review prints a guide.',
  ].join(' '));
  const view = await startView(box);
  try {
    const page = await openPage(view);
    page.run("view.tab = 'shouts'; render();");
    const feed = page.show('feed');
    const chips = [...feed.matchAll(/<code class="inline(?: [a-z]+)*"(?: title="[^"]*")?>([^<]*)<\/code>/g)].map((match) => match[1].replaceAll('&quot;', '"'));
    assert.deepEqual(chips.filter((chip) => chip.startsWith('pullboard')), ['pullboard spec check', 'pullboard view', 'pullboard next --verify 235', 'pullboard verify 235', 'pullboard relay on', 'pullboard hold', 'pullboard milestone add', 'pullboard prompt review'],
      `each chip is the command and its arguments, never the words after it: ${JSON.stringify(chips)}`);
    assert.ok(chips.includes('docs/api.md') && chips.includes('--reason'), 'a path and a flag in the prose after a command still chip on their own');
    for (const word of ['prints', 'serves', 'then', 'goes', 'now', 'after', 'own', 'for', 'a']) assert.ok(!chips.some((chip) => chip.split(' ').includes(word)), `"${word}" stays prose`);
  } finally {
    await view.stop();
  }
});

test('the view chips a command the CLI adds [N26]', async (t) => {
  const box = machine();
  const demo = project(box, 'help-copy');
  const cli = join(box.dir, 'cli-copy');
  mkdirSync(cli);
  for (const entry of ['bin', 'src', 'relay', 'test', 'skills', 'package.json']) {
    cpSync(resolve(import.meta.dirname, '../..', entry), join(cli, entry), { recursive: true });
  }
  const helpFile = join(cli, 'src', 'help.js');
  const source = readFileSync(helpFile, 'utf8');
  writeFileSync(helpFile, source
    .replace('all: ALL_HELP,', "all: ALL_HELP + '\\n  pullboard blueprint apply <path>  a copied CLI extension',")
    .replace('commands: Object.freeze(commandHelpRows(ALL_HELP)),',
      "commands: Object.freeze({ ...commandHelpRows(ALL_HELP), 'blueprint inspect': { usages: ['pullboard blueprint inspect <path>'] } }),"));
  const copiedBin = join(cli, 'bin', 'pullboard.js');
  box.run(demo.repo, 'shout', 'all', 'A CLI extension says pullboard blueprint apply <file> and pullboard blueprint inspect <path>.');
  const view = await startView(box, { bin: copiedBin });
  /** Read actual rendered chips without depending on long-chip classes or title attributes. */
  const assertChips = (page, where) => {
    page.run("view.tab = 'shouts'; render();");
    const chips = [...page.show('feed').matchAll(/<code class="inline(?: [a-z]+)*"(?: title="[^"]*")?>([^<]*)<\/code>/g)].map(match => match[1]);
    for (const phrase of ['pullboard blueprint apply', 'pullboard blueprint inspect']) {
      assert.ok(chips.includes(phrase), `${where} chips the copied CLI command ${phrase}: ${JSON.stringify(chips)}`);
    }
  };
  try {
    assertChips(await openPage(view), 'the live page');
    const output = join(box.dir, 'snapshot');
    const exported = spawnSync(process.execPath, [copiedBin, 'view', '--export', output], { cwd: demo.repo, env: box.env, encoding: 'utf8' });
    assert.equal(exported.status, 0, exported.stderr);
    const snapshotServer = createServer((req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      let file = join(output, pathname === '/' ? 'index.html' : pathname.slice(1));
      if (!existsSync(file) && existsSync(file + '.json')) file += '.json';
      if (!existsSync(file)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': file.endsWith('.json') ? 'application/json' : 'text/html' });
      res.end(readFileSync(file));
    });
    await new Promise(resolveListen => snapshotServer.listen(0, '127.0.0.1', resolveListen));
    try {
      const base = `http://127.0.0.1:${snapshotServer.address().port}`;
      assertChips(await openPage({ link: new URL(base + '/'), key: '', base: base + '/' }), 'the exported page');
    } finally {
      snapshotServer.closeAllConnections();
      await new Promise(resolveClose => snapshotServer.close(resolveClose));
    }
    const { relayClientFixture: copiedRelayFixture } = await import(pathToFileURL(join(cli, 'test', 'relay-client-fixture.js')));
    const relay = await copiedRelayFixture(t);
    const session = await relay.phoneSession();
    const response = await fetchFresh(relay.origin + '/', { headers: { cookie: 'pb_session=' + session.token } });
    assert.equal(response.status, 200, 'the copied CLI relay serves its real authenticated person page');
    const html = await response.text();
    for (const phrase of ['blueprint apply', 'blueprint inspect']) {
      assert.match(html, new RegExp('pullboard \\(\\?:[^)]*' + phrase), 'the relay derives copied help phrase ' + phrase);
    }
  } finally { await view.stop(); }
});

test('real Chrome renders brief lists with inline paths [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for brief list checks.');

  const box = machine();
  const demo = project(box, 'briefs');
  const brief = ['The person called the old rendering ugly.', '', 'Files:', '- web/index.html', '- web/app.js', '- web/style.css', '- web/api.md', '',
    'Test:', '- node bin/run-tests.js --test-name-pattern "brief lists" test/cockpit.test.js', '- make test stays prose', '- a parent bullet',
    '  - capture, measurement, `note`', '  - decision, rejection', '', 'Sentences:',
    '- pullboard spec check prints a DOCTRINE.md line with 0 errors, and no PRACTICE.md remains at the root.', '- npm test runs the suite before every push', '- git merge main'].join('\n');
  box.run(demo.repo, 'add', 'web', 'A brief with lists', '--specs', 'G1', '--criterion', 'lists', '--brief', brief);
  box.run(demo.repo, 'shout', 'all', 'A fence still reads as code:\n```\nconst greeting = "hello";\n```');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-brief-lists-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data && !!data.project && !!document.querySelector('#detail .text.muted')");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.querySelector('#detail .text.muted ul') !== null`);
      const seen = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
        const text = document.querySelector('#detail .text.muted');
        const lists = [...text.querySelectorAll(':scope > ul.text-list')];
        const label = (list) => { let n = list.previousSibling; while (n && n.nodeType === 3 && !n.textContent.trim()) n = n.previousSibling; return n ? (n.nodeType === 3 ? n.textContent : n.textContent).trim().split('\\n').pop() : ''; };
        const item = (li) => ({ text: li.firstChild ? [...li.childNodes].filter((n) => n.nodeName !== 'UL').map((n) => n.textContent).join('') : '',
          codes: [...li.querySelectorAll(':scope > code')].map((code) => [code.textContent, getComputedStyle(code).display]), nested: [...li.querySelectorAll(':scope > ul > li')].map((child) => child.textContent) });
        const line = parseFloat(getComputedStyle(text).lineHeight);
        const testLabelTop = (() => { const r = document.createRange(); const node = [...text.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes('Test:')); r.selectNode(node); return r.getBoundingClientRect().top; })();
        return { lists: lists.map((list) => ({ label: label(list), items: [...list.querySelectorAll(':scope > li')].map(item) })),
          blocks: text.querySelectorAll('code.block, .code').length, dashes: text.innerText.split('\\n').filter((l) => l.trim().startsWith('-')).length,
          gap: (testLabelTop - lists[0].getBoundingClientRect().bottom) / line, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
      })())`));
      const place = `${width}: ${JSON.stringify(seen)}`;
      assert.deepEqual(seen.lists.map((list) => list.label), ['Files:', 'Test:', 'Sentences:'], `${width}: each label stays a plain line above its own list`);
      assert.deepEqual(seen.lists[0].items.map((li) => li.codes), [[['web/index.html', 'inline']], [['web/app.js', 'inline']], [['web/style.css', 'inline']], [['web/api.md', 'inline']]],
        `each path is a bullet holding one inline chip at ${place}`);
      const [command, prose, parent] = seen.lists[1].items;
      assert.deepEqual(command.codes, [['node bin/run-tests.js --test-name-pattern "brief lists" test/cockpit.test.js', 'inline']], `${width}: a whole command bullet is one chip`);
      assert.deepEqual([prose.text, prose.codes], ['make test stays prose', []], `${width}: any other command, unmarked, stays prose`);
      assert.deepEqual(parent.nested, ['capture, measurement, note', 'decision, rejection'], `${width}: indented bullets nest under the bullet above them`);
      // A bullet that only starts with a command is a sentence, never one chip; the command alone is.
      const [sentence, runs, merge] = seen.lists[2].items;
      assert.ok(!sentence.codes.some(([code]) => code === sentence.text) && /0 errors, and no/.test(sentence.text), `${width}: a sentence that starts with pullboard stays prose: ${JSON.stringify(sentence)}`);
      assert.ok(!runs.codes.some(([code]) => code === runs.text), `${width}: so does one that starts with npm and goes on in words: ${JSON.stringify(runs)}`);
      assert.deepEqual(merge.codes, [['git merge main', 'inline']], `${width}: a short command alone is one chip`);
      assert.deepEqual([seen.blocks, seen.dashes], [0, 0], `${width}: no code block and no stray dash in the brief`);
      assert.ok(seen.gap > 0.4 && seen.gap < 1.6, `${width}: one blank line between a list and the next label, as written: ${seen.gap.toFixed(2)} lines`);
      assert.ok(!seen.overflow, `${width}: nothing runs off the screen`);
    }
    await chrome.evaluate("document.querySelector('[data-tab=\"shouts\"]').click()");
    await chrome.waitFor("[...document.querySelectorAll('#feed code.block')].some((code) => code.textContent.includes('const greeting'))");
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
