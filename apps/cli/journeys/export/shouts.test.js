// pullboard: browser
/** @pullboard-test-gui */
/** Addressed shouts, grouped repos, relay history and the sandbox-blocked view port [N38,N26,H5]. */
import { main as nativeTestMain } from '../../tests/fixtures/native.js';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import { stableChrome } from '../../tests/fixtures/cockpit/stable.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import {
  startChrome,
  relayWorkBudgetMs,
} from '../../tests/fixtures/relay/browser.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { chooseViewPort } from '../../tests/fixtures/view/port.js';
import {
  machine,
  project,
  boardOf,
  press,
  travel,
  settled,
} from '../../tests/fixtures/cockpit/harness.js';
import {
  SCRIPT,
  assertPlace,
  openAddress,
  assertHeading,
  history,
  onePlace,
  addressBoard,
  withBrowser,
  assertShout,
} from '../../tests/fixtures/cockpit/addresses.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
test('a shout address opens an old shout [N38,N26]', { timeout: 180_000 }, async () => { // budget: hang-only ceiling for real writes and both viewport journeys.
  const box = machine(), alpha = addressBoard(box, 'old-shout-alpha');
  await box.inProcess(alpha.repo, 'shout', 'person', 'OLD ADDRESSED SHOUT, unique body.');
  await withBrowser(box, async (chrome, server) => {
    const target = (await boardOf(server, alpha.repo)).shouts.find(one => one.shout_text === 'OLD ADDRESSED SHOUT, unique body.');
    assert.ok(target?.shout_id);
    for (let index = 0; index < 46; index += 1) await box.inProcess(alpha.repo, 'shout', 'person', `Later shout ${index + 1}.`);
    const state = await boardOf(server, alpha.repo);
    assert.equal(state.shouts.length, 40);
    assert.equal(state.shouts.some(one => one.shout_id === target.shout_id), false, 'the target is outside the actual public state window');
    for (const width of [1280, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await openAddress(chrome, server, `/shouts/${target.shout_id}`);
      await assertPlace(chrome, `/shouts/${target.shout_id}`, 'shouts', alpha.repo);
      await assertShout(chrome, target.shout_id, 'OLD ADDRESSED SHOUT, unique body.');
    }
  });
});

/** Read stable document-space boxes and the accessible heading for one addressed shout. */
async function shoutLayout(chrome, id) {
  return JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const card = document.querySelector('#shout-${id}');
    /** Convert one rendered node to stable document-space geometry. */
    const box = node => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { left: rect.left + scrollX, top: rect.top + scrollY, width: rect.width, height: rect.height };
    };
    const heading = card?.querySelector('h2');
    return { card: box(card), avatar: box(card?.querySelector('.avatar')), text: box(card?.querySelector('.text')), header: box(card?.querySelector('header')),
      heading: heading ? { tag: heading.tagName, text: heading.textContent } : null,
      found: card?.classList.contains('found') ?? false };
  })())`));
}

test('an addressed shout is highlighted without changing its layout [N26,N38]', { timeout: 180_000 }, async (t) => { // budget: hang-only ceiling for four real Chrome viewport and theme checks.
  const box = machine(), alpha = addressBoard(box, 'shout-layout');
  const text = 'Shout whose address must not change its layout.';
  await box.inProcess(alpha.repo, 'shout', 'person', text);
  await withBrowser(box, async (chrome, server) => {
    const shout = (await boardOf(server, alpha.repo)).shouts.find(one => one.shout_text === text);
    assert.ok(shout?.shout_id, 'the real board contains the addressed shout');
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      assert.equal(await chrome.stable(`matchMedia('(prefers-color-scheme: ${scheme})').matches`), true, `${scheme} media is active`);
      for (const width of [375, 1280]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.waitFor(`innerWidth === ${width}`);
        await openAddress(chrome, server, '/shouts');
        await assertPlace(chrome, '/shouts', 'shouts', alpha.repo);
        await press(chrome, 'document.querySelector(\'[data-shout-thread="none"]\')');
        await settled(chrome, `!!document.querySelector('#shout-${shout.shout_id} .text')`);
        const before = await shoutLayout(chrome, shout.shout_id);
        assert.ok(before.card && before.text && before.header, `${width}px ${scheme}: the opened conversation has its message layout boxes`);
        assert.equal(before.avatar, null, 'the approved conversation has no avatar');
        assert.equal(before.heading, null, `${width}px ${scheme}: the unaddressed shout has no detail heading`);
        await openAddress(chrome, server, `/shouts/${shout.shout_id}`);
        await assertPlace(chrome, `/shouts/${shout.shout_id}`, 'shouts', alpha.repo);
        await assertShout(chrome, shout.shout_id, text);
        const after = await shoutLayout(chrome, shout.shout_id);
        t.diagnostic('515-layout-geometry ' + JSON.stringify({ width, scheme, before, after }));
        assert.equal(after.heading?.tag, 'H2', `${width}px ${scheme}: address keeps its semantic heading`);
        assert.equal(after.heading?.text, `Shout #${shout.shout_id}`, `${width}px ${scheme}: heading names the shout`);
        assert.equal(after.found, true, `${width}px ${scheme}: addressed card is highlighted`);
        assert.deepEqual(after.card, before.card, `${width}px ${scheme}: addressed card keeps its document-space box`);
        assert.equal(after.avatar, null, 'addressing never adds an avatar');
        assert.deepEqual(after.text, before.text, `${width}px ${scheme}: the native message text stays in place`);
        assert.deepEqual(after.header, before.header, `${width}px ${scheme}: header stays in place`);
      }
    }
  });
});

test('grouped repos each get their own address [N38,N26]', { timeout: 180_000 }, async () => { // budget: hang-only ceiling for grouped repo switching and a separate one-repo machine.
  const box = machine(), alpha = addressBoard(box, 'alpha', 'same-suite'), beta = addressBoard(box, 'beta', 'same-suite');
  await withBrowser(box, async (chrome, server) => {
    for (const [repo, name] of [[alpha, 'alpha'], [beta, 'beta']]) {
      for (const [suffix, pane, selector, id, text] of [
        ['/items/1', 'items', '#detail', '#1', `${name} first address item`],
        ['/spec/G2', 'spec', '#spec-detail', 'G2', `${name} distinct specification row`],
        ['/doctrine/PB1', 'doctrine', '#doctrine-detail', 'PB1', `${name} distinct practice rule`],
      ]) {
        await openAddress(chrome, server, `/${name}${suffix}`);
        await assertPlace(chrome, `/${name}${suffix}`, pane, repo.repo);
        await assertHeading(chrome, selector, id, text);
      }
      await onePlace(chrome, 'document.querySelector(\'[data-tab="shouts"]\')', `/${name}/shouts`, 'shouts', repo.repo);
    }
    await openAddress(chrome, server, '/alpha/items/1');
    if (await chrome.stable("getComputedStyle(document.querySelector('#side .side-body')).display === 'none'")) await press(chrome, "document.querySelector('#proj-switch')");
    await onePlace(chrome, 'document.querySelector(\'[data-root="' + beta.repo + '"]\')', '/beta/items', 'items', beta.repo);
    await travel(chrome, -1);
    await settled(chrome, `${SCRIPT} && view.root === ${JSON.stringify(alpha.repo)}`);
    await assertPlace(chrome, '/alpha/items/1', 'items', alpha.repo);
    await assertHeading(chrome, '#detail', '#1', 'alpha first address item');
  });
  const singleBox = machine(), single = addressBoard(singleBox, 'single');
  await withBrowser(singleBox, async (chrome, server) => {
    await openAddress(chrome, server, '/items/1');
    await assertPlace(chrome, '/items/1', 'items', single.repo);
    await assertHeading(chrome, '#detail', '#1', 'single first address item');
    await onePlace(chrome, 'document.querySelector(\'[data-tab="spec"]\')', '/spec', 'spec', single.repo);
    await onePlace(chrome, 'document.querySelector(\'[data-row="spec:G2"]\')', '/spec/G2', 'spec', single.repo);
    await assertHeading(chrome, '#spec-detail', 'G2', 'single distinct specification row');
  });
});


test('an older relay shout keeps its address and explains retained history [N38,H5]', {
  // budget: three fixture work ceilings bound setup, browser pairing and the addressed read; no speed assertion.
  timeout: relayWorkBudgetMs() * 3,
}, async t => {
  const box = await relayClientFixture(t);
  const text = 'OLD RELAY ADDRESS TARGET 187';
  for (let index = 0; index < 46; index += 1) {
    const reply = await box.cliLocal('shout', 'person', index === 0 ? text : `Later relay address shout ${index}`);
    assert.equal(reply.code, 0, 'real CLI appends each fixture shout');
  }
  const exported = await box.cliLocal('export');
  assert.equal(exported.code, 0);
  const target = exported.document.tables.shout.find(one => one.shout_text === text);
  assert.ok(target?.shout_id);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const encoded = readFileSync(box.keyFile, 'utf8').trim();
  const chrome = await stableChrome(await startChrome());
  t.after(() => chrome.close());
  assert.equal((await chrome.send('Network.setCookie', {
    name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  })).success, true, 'the actual paired person session authenticates this browser');
  await chrome.send('Page.navigate', { url: box.origin + '/#board=' + link.board + '&key=' + encoded });
  await settled(chrome, SCRIPT);
  assert.equal(await chrome.stable('location.hash.includes("key=")'), false, 'pairing removes its secret before ordinary address navigation');
  assert.equal(await chrome.stable(`data.project.shouts.some(one => one.shout_id === ${target.shout_id})`), false, 'the old shout is absent from the actual relay state projection');
  const address = '/#shouts/' + target.shout_id;
  await chrome.send('Page.navigate', { url: box.origin + address });
  await settled(chrome, SCRIPT);
  for (let visit = 0; visit < 2; visit += 1) {
    await settled(chrome, `${SCRIPT} && !document.querySelector('#shout-address-status')?.textContent.startsWith('Loading')`);
    await assertPlace(chrome, address, 'shouts', link.board);
    const body = await chrome.stable(`document.querySelector('#feed #shout-${target.shout_id} .text')?.textContent ?? null`);
    if (body === text) await assertShout(chrome, target.shout_id, text);
    else assert.match(await chrome.stable("document.querySelector('#shout-address-status')?.textContent ?? ''"), /older than the relay holds/i,
      'an unsupported old read explains the relay retention limit in the Shouts pane');
    if (visit === 0) {
      const before = await chrome.stable('performance.timeOrigin');
      await chrome.send('Page.reload');
      await settled(chrome, `performance.timeOrigin !== ${before} && ${SCRIPT}`);
    }
  }
});

/** Write a preload that makes every listen fail as a sandbox does, so no real port is touched. */
function sandboxListenStub(dir, code) {
  const file = join(dir, `listen-${code}.mjs`);
  writeFileSync(file, `import { Server } from 'node:net';
Server.prototype.listen = function (port, host) {
  const error = Object.assign(new Error(\`listen ${code}: operation not permitted \${host}:\${port}\`), { code: '${code}', errno: -1, syscall: 'listen', address: host, port });
  process.nextTick(() => this.emit('error', error));
  return this;
};
`);
  return file;
}

test('a sandbox-blocked view port names the fix [I1,L3,P4]', { timeout: 120_000 }, async (t) => { // budget: hang ceiling for six short CLI refusals.
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-view-sandbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const port = await chooseViewPort();
  const terminal = 'or start pullboard view from a normal terminal';
  const harnesses = [
    { name: 'Claude Code', env: { CLAUDECODE: '1' },
      next: `allow local network for Claude Code: set sandbox.network.allowLocalBinding to true in .claude/settings.json, ${terminal}` },
    { name: 'Codex', env: { CODEX_SANDBOX: 'seatbelt' },
      next: `allow local network for Codex in its sandbox settings in ~/.codex/config.toml, ${terminal}` },
    { name: 'another agent tool', env: {},
      next: `allow local network in your agent tool's sandbox settings, ${terminal}` },
  ];
  // The view's own refusal, in process: the stub replaces listen only for this call.
  const { serveView } = await import('../../src/io/commands/view.js');
  const { Server } = await import('node:net');
  const listen = Server.prototype.listen;
  const saved = { CLAUDECODE: process.env.CLAUDECODE, CODEX_SANDBOX: process.env.CODEX_SANDBOX, CODEX_SANDBOX_NETWORK_DISABLED: process.env.CODEX_SANDBOX_NETWORK_DISABLED };
  t.after(() => { Server.prototype.listen = listen; for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value; });
  for (const code of ['EPERM', 'EACCES']) {
    Server.prototype.listen = function (asked, host) {
      process.nextTick(() => this.emit('error', Object.assign(new Error(`listen ${code}: operation not permitted ${host}:${asked}`), { code, syscall: 'listen' })));
      return this;
    };
    for (const name of Object.keys(saved)) delete process.env[name];
    process.env.CLAUDECODE = '1';
    await assert.rejects(serveView({ port, runCommand: nativeTestMain }), (error) => {
      assert.equal(error.code, 'SANDBOX_BLOCKED');
      assert.equal(error.message, `[SANDBOX_BLOCKED] the sandbox around this command refused to let pullboard view listen on 127.0.0.1:${port} (${code})\nnext: ${harnesses[0].next}`);
      return true;
    });
  }
  Server.prototype.listen = listen;

  // The CLI, in the background launch an agent gets and in the foreground, plain and --json.
  const stub = sandboxListenStub(dir, 'EPERM');
  for (const harness of harnesses) {
    for (const foreground of [false, true]) {
      const env = { ...process.env, HOME: join(dir, 'home'), PULLBOARD_HOME: join(dir, 'home', '.pullboard'),
        PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), PULLBOARD_VIEW_PORT: String(port),
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', NODE_OPTIONS: `--import=${pathToFileURL(stub).href}`, ...harness.env };
      for (const name of ['CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'AI_AGENT', 'PULLBOARD_VIEW_FOREGROUND']) if (!(name in harness.env)) delete env[name];
      if (foreground) env.PULLBOARD_VIEW_FOREGROUND = '1';
      // Process-level case: the NODE_OPTIONS import stub and exit status only exist in a real child, so this one launch stays a process.
      const run = (...extra) => runFixtureChild(process.execPath, [BIN, 'view', '--no-open', ...extra], { cwd: dir, env, encoding: 'utf8', timeout: 40_000 });
      const where = `${harness.name}, ${foreground ? 'foreground' : 'background'}`;
      const plain = run();
      assert.equal(plain.status, 1, `${where}: ${plain.failure ?? plain.stderr}`);
      const json = run('--json');
      assert.equal(json.status, 1, `${where}: ${json.failure ?? json.stderr}`);
      const refusal = JSON.parse(json.stdout).error;
      assert.equal(refusal.code, 'SANDBOX_BLOCKED', where);
      assert.equal(refusal.next, harness.next, `${where}: the step names the fix for this harness`);
      assert.equal(plain.stderr.trim(), `pullboard: [SANDBOX_BLOCKED] the sandbox around this command refused to let pullboard view listen on 127.0.0.1:${port} (EPERM)\nnext: ${harness.next}`, where);
      for (const text of [plain.stderr, json.stdout]) assert.doesNotMatch(text, /service owner/iu, `${where}: the step points somewhere real`);
    }
  }
});
