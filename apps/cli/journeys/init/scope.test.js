// pullboard: browser
/** @pullboard-test-gui */
/** Project-scoped view privacy checks against the real local server and Chrome [N26,P5]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BIN,
  closeSnapshotChrome,
  chromeExecutable,
  fetchLive,
  machine,
  openSnapshotChrome,
  project,
  startView,
} from '../../tests/fixtures/cockpit/harness.js';

/** Start a scoped view from a registered project's repository and wait for its private page to answer.
 * @param {{ env: NodeJS.ProcessEnv }} box
 * @param {string} repo
 * @returns {Promise<{ link: URL, base: string, key: string | null, stop: () => Promise<void> }>}
 */
async function startProjectView(box, repo) {
  const child = spawn(process.execPath, [BIN, 'view', '--project', '--no-open', '--port', '0'], {
    cwd: repo, env: { ...box.env, PULLBOARD_VIEW_FOREGROUND: '1' }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  let output = '';
  try {
    const link = await new Promise((resolve, reject) => {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = /Pullboard view: (http:\/\/127\.0\.0\.1:\d+\/\?k=\S+)/u.exec(output);
        if (match) resolve(new URL(match[1]));
      });
      child.once('error', () => reject(new Error('the scoped view process could not start')));
      child.once('exit', () => reject(new Error('the scoped view exited before printing its link')));
    });
    // The printed link trades its key for the session cookie (N39); its answer shows the view is serving.
    const ready = await fetchLive(link.href, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    assert.equal(ready.status, 303, 'the scoped view answers before its pages are read');
    await ready.arrayBuffer();
    return {
      link,
      base: link.origin,
      key: link.searchParams.get('k'),
      stop: () => new Promise((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done();
        child.once('exit', done);
        child.kill('SIGTERM');
      }),
    };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    throw error;
  }
}

test('[N26,P5] a one-project view never reveals the others [N26,P5]', { timeout: 120_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required to check the rendered project view.');
  const box = machine();
  const visibleName = 'Visible Project 583';
  const privateName = 'Private Project Marker 583';
  const privateTitle = 'Private Item Marker 583';
  const visible = project(box, 'visible-project-583', undefined, { name: visibleName });
  const privateProject = project(box, 'private-project-583', undefined, { name: privateName });
  box.run(visible.repo, 'add', 'web', 'Visible Item 583', '--specs', 'G1', '--criterion', 'visible in its project');
  box.run(privateProject.repo, 'add', 'web', privateTitle, '--specs', 'G1', '--criterion', 'private to its project');

  let ownerView;
  let scopedView;
  let chrome;
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-project-scope-chrome-'));
  try {
    ownerView = await startView(box);
    const ownerResponse = await fetchLive(`${ownerView.base}/api/v1/boards`, { headers: { 'x-pullboard-key': ownerView.key } });
    assert.equal(ownerResponse.status, 200);
    const ownerBoards = (await ownerResponse.json()).boards;
    assert.deepEqual(new Set(ownerBoards.map((board) => board.root)), new Set([visible.repo, privateProject.repo]), 'plain view keeps the machine owner’s project list');
    const privateBoardId = ownerBoards.find((board) => board.root === privateProject.repo)?.id;
    assert.ok(privateBoardId, 'the private project has an API identity in the default view');
    await ownerView.stop();
    ownerView = null;

    scopedView = await startProjectView(box, visible.repo);
    const headers = { 'x-pullboard-key': scopedView.key };
    const listingResponse = await fetchLive(`${scopedView.base}/api/v1/boards`, { headers });
    assert.equal(listingResponse.status, 200);
    const listing = await listingResponse.json();
    assert.deepEqual(listing.boards.map((board) => board.root), [visible.repo], 'the scoped API names only the invoking repository');
    const listingText = JSON.stringify(listing);
    assert.equal(listingText.includes(privateName), false, 'the project list contains no private name');
    assert.equal(listingText.includes(privateProject.repo), false, 'the project list contains no private path');

    const foreignBase = `${scopedView.base}/api/v1/boards/${encodeURIComponent(privateBoardId)}`;
    for (const path of ['/state', '/events?after=0', '/items?q=Private%20Item%20Marker%20583', '/items/1', '/shouts/1']) {
      const response = await fetchLive(foreignBase + path, { headers });
      assert.equal(response.status, 404, `${path} cannot access a private board through the scoped API`);
      const refusal = await response.text();
      assert.equal(refusal.includes(privateName), false, `${path} refusal does not disclose the private name`);
      assert.equal(refusal.includes(privateProject.repo), false, `${path} refusal does not disclose the private path`);
      assert.equal(refusal.includes(privateTitle), false, `${path} refusal does not disclose the private item`);
    }
    const streamResponse = await fetchLive(`${scopedView.base}/api/v1/events?boards=${encodeURIComponent(privateBoardId)}`, {
      headers: { ...headers, accept: 'text/event-stream' },
    });
    assert.equal(streamResponse.status, 404, 'a private board id cannot enter the multi-board event stream');
    const streamRefusal = await streamResponse.text();
    assert.equal(streamRefusal.includes(privateName), false, 'the stream refusal does not disclose the private name');
    assert.equal(streamRefusal.includes(privateProject.repo), false, 'the stream refusal does not disclose the private path');
    assert.equal(streamRefusal.includes(privateTitle), false, 'the stream refusal does not disclose the private item');

    for (const path of ['/', '/items', '/shouts', '/spec', '/doctrine', '/activity', '/roadmap', `/${encodeURIComponent(privateName)}/items`]) {
      const response = await fetchLive(scopedView.base + path, { headers });
      assert.equal(response.status, 200, `${path} remains an in-scope view page`);
      const page = await response.text();
      assert.equal(page.includes(privateName), false, `${path} does not embed another project name`);
      assert.equal(page.includes(privateProject.repo), false, `${path} does not embed another project path`);
    }

    chrome = await openSnapshotChrome(executable, scopedView.link.href, profile);
    await chrome.waitFor(`data?.projects?.length === 1 && data.projects[0]?.root === ${JSON.stringify(visible.repo)} && document.querySelector('[data-root]')`);
    await chrome.click("document.querySelector('[data-tab=\"items\"]')"); // a person opens Items before the list is drawn, since pages open on the Dashboard.
    await chrome.waitFor(`document.body.innerText.includes(${JSON.stringify(visibleName)}) && document.body.innerText.includes('Visible Item 583')`);
    const rendered = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const links = [...document.querySelectorAll('a[href]')].map(link => new URL(link.href, location.href).pathname);
      const roots = [...document.querySelectorAll('[data-root]')].map(node => node.getAttribute('data-root'));
      const text = document.body.innerText;
      return {
        roots:data.projects.map(project => project.root), groups:data.groups.map(group => group.name),
        sidebarRoots:roots, linkPaths:links,
        visibleName:text.includes(${JSON.stringify(visibleName)}), visibleTitle:text.includes('Visible Item 583'), privateName:text.includes(${JSON.stringify(privateName)}),
        privatePath:text.includes(${JSON.stringify(privateProject.repo)}), privateTitle:text.includes(${JSON.stringify(privateTitle)}),
        privateLink:links.some(path => path.includes(${JSON.stringify(encodeURIComponent(privateName))})),
      };
    })())`));
    assert.deepEqual(rendered.roots, [visible.repo], 'the page holds one project');
    assert.deepEqual(rendered.groups, [], 'another repository cannot contribute a project group');
    assert.deepEqual(new Set(rendered.sidebarRoots), new Set([visible.repo]), 'the project selector has no other root');
    assert.equal(rendered.visibleName, true, 'the selected project remains visible');
    assert.equal(rendered.visibleTitle, true, 'the selected project board remains usable');
    assert.equal(rendered.privateName, false, 'the page does not name another project');
    assert.equal(rendered.privatePath, false, 'the page does not expose another project path');
    assert.equal(rendered.privateTitle, false, 'the page does not show another project’s item');
    assert.equal(rendered.privateLink, false, 'generated links stay inside the selected project');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    if (scopedView) await scopedView.stop();
    if (ownerView) await ownerView.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
