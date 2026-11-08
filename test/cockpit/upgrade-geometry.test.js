// pullboard: browser
/** @pullboard-test-gui */
/** Real private CLI restart and upgrade presentation journey, registered by the Items and geometry checks [N26]. */
import { copyPackageFiles } from '../../packages/runners/index.js';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { machine, project, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, pickProject, press } from './fixture.js';

test('the view shows what is new once after an upgrade [N26]', async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'real Chrome is required for the upgrade journey');
  for (const [width, height] of [[375, 812], [1280, 800]]) for (const scheme of ['light', 'dark']) {
    const box = machine();
    const alpha = project(box, 'upgrade-alpha');
    const beta = project(box, 'upgrade-beta');
    for (const board of [alpha, beta]) box.run(board.repo, 'add', 'web', 'First visible item', '--specs', 'G1');
    const cli = join(box.dir, 'upgrade-cli');
    mkdirSync(cli);
    copyPackageFiles(resolve(import.meta.dirname, '../..'), cli);
    const packagePath = join(cli, 'package.json');
    const packageData = JSON.parse(readFileSync(packagePath, 'utf8'));
    const releases = ['0.8.10', '0.8.9', '0.8.8', '0.8.7', '0.8.4'];
    const paragraph = 'These release details explain what changed for the person using the board. '.repeat(8).trim();
    writeFileSync(join(cli, 'CHANGELOG.md'), '# Changelog\n\n' + releases.map(version => `## [${version}] - 2026-10-11\n\n### Release ${version}\n\n${paragraph}\n\n### Added\n\n- Detailed changes stay in the full notes.\n`).join('\n'));
    writeFileSync(packagePath, JSON.stringify({ ...packageData, version: '0.8.4' }));
    let server = await startView(box, { bin: join(cli, 'bin/pullboard.js') });
    let chrome;
    try {
      chrome = await openSnapshotChrome(executable, server.link.href, join(box.dir, 'upgrade-chrome'));
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      /** Wait for this document's actual board state and script, including after a server restart. */
      const ready = async (version, root) => {
        await chrome.waitFor(`!window.__oldUpgradeDocument && typeof data === 'object' && data?.project?.releaseNotes?.version === ${JSON.stringify(version)} && data.project.root === ${JSON.stringify(root)}`);
        await chrome.click("document.querySelector('[data-tab=items]')");
        await chrome.waitFor(`document.querySelector('#chain .row')`);
      };
      await ready('0.8.4', alpha.repo);
      assert.equal(await chrome.stable("document.querySelector('#upgrade-note').hidden"), true, 'a fresh browser records the version quietly');
      assert.equal(await chrome.stable(`localStorage.getItem('pb.release.' + ${JSON.stringify(alpha.repo)})`), '0.8.4', 'the first board records its initial version');
      await pickProject(chrome, `document.querySelector('[data-root="${beta.repo}"]')`);
      await ready('0.8.4', beta.repo);
      assert.equal(await chrome.stable("document.querySelector('#upgrade-note').hidden"), true, 'a second fresh board also records quietly');
      await pickProject(chrome, `document.querySelector('[data-root="${alpha.repo}"]')`);
      await ready('0.8.4', alpha.repo);
      const previousOrigin = server.link.origin;
      await server.stop();
      writeFileSync(packagePath, JSON.stringify({ ...packageData, version: '0.8.10' }));
      server = await startView(box, { bin: join(cli, 'bin/pullboard.js') });
      assert.equal(server.link.origin, previousOrigin, 'a CLI restart keeps the browser storage origin');
      await chrome.stable('window.__oldUpgradeDocument = true');
      await chrome.send('Page.navigate', { url: server.link.href });
      await ready('0.8.10', alpha.repo);
      await chrome.waitFor("!document.querySelector('#upgrade-note').hidden");
      const shown = JSON.parse(await chrome.stable(`JSON.stringify({
        title: document.querySelector('#upgrade-note h2').textContent,
        headings: [...document.querySelectorAll('#upgrade-note article h3')].map(node => node.textContent),
        paragraphs: [...document.querySelectorAll('#upgrade-note article p')].map(node => node.textContent),
        more: document.querySelector('#upgrade-note footer').textContent,
        notes: document.querySelector('#upgrade-note a').href,
        cardBottom: document.querySelector('#upgrade-note').getBoundingClientRect().bottom,
        itemTop: document.querySelector('#chain .row').getBoundingClientRect().top,
        itemBottom: document.querySelector('#chain .row').getBoundingClientRect().bottom,
        viewport: innerHeight, width: innerWidth, pageWidth: document.documentElement.scrollWidth,
        scheme: matchMedia('(prefers-color-scheme: ${scheme})').matches,
      })`));
      assert.equal(shown.title, 'New in 0.8.10', 'the current CLI version names the card');
      assert.deepEqual(shown.headings, ['0.8.10 · Release 0.8.10', '0.8.9 · Release 0.8.9', '0.8.8 · Release 0.8.8'], 'at most three newer headlines appear in numeric newest-first order');
      assert.deepEqual(shown.paragraphs, [paragraph, paragraph, paragraph], 'each complete headline paragraph comes through the real board API');
      assert.match(shown.more, /^\+1 more/, 'remaining releases are counted');
      assert.equal(shown.notes, 'https://github.com/pullboard-dev/pullboard/blob/main/CHANGELOG.md', 'the card links to the full notes');
      assert.ok(shown.cardBottom <= shown.itemTop && shown.itemBottom <= shown.viewport, `${width}/${scheme}: the card leaves the complete first item above the fold: ${JSON.stringify(shown)}`);
      assert.ok(shown.pageWidth <= shown.width, `${width}/${scheme}: the page never scrolls sideways`);
      assert.equal(shown.scheme, true, 'the actual browser uses the requested color scheme');
      const reachable = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const card = document.querySelector('#upgrade-note');
        card.scrollTop = card.scrollHeight;
        const bounds = card.getBoundingClientRect(), link = card.querySelector('footer a').getBoundingClientRect();
        const result = { scrolled: card.scrollTop > 0, linkVisible: link.top >= bounds.top && link.bottom <= bounds.bottom };
        card.scrollTop = 0;
        return result;
      })())`));
      assert.equal(reachable.scrolled, true, `${width}/${scheme}: complete long release details remain scrollable`);
      assert.equal(reachable.linkVisible, true, `${width}/${scheme}: full release notes stay reachable inside the notice`);

      if (process.env.PULLBOARD_UPGRADE_PROOF) {
        mkdirSync(process.env.PULLBOARD_UPGRADE_PROOF, { recursive: true });
        const shot = await chrome.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(process.env.PULLBOARD_UPGRADE_PROOF, `upgrade-${width}-${scheme}.png`), Buffer.from(shot.data, 'base64'));
      }
      await chrome.stable('window.__oldUpgradeDocument = true');
      await chrome.send('Page.reload');
      await ready('0.8.10', alpha.repo);
      assert.equal(await chrome.stable("document.querySelector('#upgrade-note').hidden"), true, 'a same-version reload does not show the note again');
      await pickProject(chrome, `document.querySelector('[data-root="${beta.repo}"]')`);
      await ready('0.8.10', beta.repo);
      assert.equal(await chrome.stable("document.querySelector('#upgrade-note').hidden"), false, 'a different board has its own unseen upgrade');
      await press(chrome, "document.querySelector('[data-upgrade-dismiss]')");
      assert.equal(await chrome.stable("document.querySelector('#upgrade-note').hidden"), true, 'dismissing removes the card');
      await chrome.stable('window.__oldUpgradeDocument = true');
      await chrome.send('Page.reload');
      await ready('0.8.10', beta.repo);
      assert.equal(await chrome.stable("document.querySelector('#upgrade-note').hidden"), true, 'a dismissed note stays dismissed on reload');
      assert.deepEqual(chrome.exceptions, [], 'the upgrade journey has no page exceptions');
    } finally {
      if (chrome) await closeSnapshotChrome(chrome);
      await server.stop();
    }
  }
});
