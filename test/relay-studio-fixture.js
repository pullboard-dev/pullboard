/** A computer named studio pairs a phone through the loopback relay and asks it to approve [H17,H5]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFixtureChild, runFixtureChild } from './fixture-child.js';
import { startChrome } from './relay-browser-fixture.js';

const CLI = resolve(import.meta.dirname, '../bin/pullboard.js');

/** The phone's own clock and words: a time zone far from UTC, so a UTC time on the card shows. */
export const PHONE_TIME_ZONE = 'Pacific/Auckland';

/** Give every CLI child the host name studio by preloading a module, leaving the product code unchanged. */
function studioEnv(box) {
  const preload = join(dirname(box.root), 'studio-host.mjs');
  if (!existsSync(preload)) {
    writeFileSync(preload, "import os from 'node:os';\nimport { syncBuiltinESMExports } from 'node:module';\n" +
      "os.hostname = () => 'studio';\nsyncBuiltinESMExports();\n", { mode: 0o600 });
  }
  return { ...box.env, NODE_OPTIONS: [box.env.NODE_OPTIONS, '--import=' + pathToFileURL(preload).href].filter(Boolean).join(' ') };
}

/** Run the production CLI on studio and return its JSON document once it exits. */
export function studioCommand(box, cwd, args) {
  const child = startFixtureChild(process.execPath, [CLI, ...args, '--json'], { cwd, env: studioEnv(box), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
  const done = new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) return reject(new Error(child.fixtureFailure ?? 'studio CLI child stopped by ' + signal));
      try { resolveResult({ code, document: JSON.parse(stdout) }); }
      catch { reject(new Error(child.fixtureFailure ?? 'studio CLI child printed no JSON (exit ' + code + ')')); }
    });
  });
  return { child, done };
}

/** Make a committed project folder with an origin and register it on studio through pullboard init. */
export async function studioProject(box, name) {
  const root = join(dirname(box.root), name);
  mkdirSync(root);
  box.providerState.repositories.push('repository-' + name); // its own repository: one team board per repository [E12]
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'fixture base'],
    ['remote', 'add', 'origin', `git@github.com:fixture/repository-${name}.git`]]) {
    assert.equal(runFixtureChild('git', args, { cwd: root, env: box.env }).status, 0);
  }
  assert.equal((await studioCommand(box, root, ['init']).done).code, 0, 'pullboard init registers ' + name + ' on studio');
  return root;
}

/** Poll the machine file for a value the running setup writes, without retrying the setup itself. */
async function machineValue(file, read, message, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  do {
    const value = existsSync(file) ? read(JSON.parse(readFileSync(file, 'utf8'))) : null;
    if (value) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  } while (Date.now() < until);
  assert.fail(message);
}

/** Set up relay on --all on studio and pair a phone-sized Chrome in the phone's own time zone. */
export async function pairStudioPhone(t, box) {
  const setup = studioCommand(box, box.root, ['relay', 'on', '--all', '--url', box.origin]);
  const chrome = await startChrome();
  t.after(async () => {
    await chrome.close();
    if (setup.child.exitCode === null) setup.child.kill('SIGTERM');
    await setup.done.catch(() => {});
  });
  const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  const pending = await machineValue(machineFile, state => state.pending, 'relay on --all on studio publishes a one-use phone pairing');
  await chrome.send('Emulation.setTimezoneOverride', { timezoneId: PHONE_TIME_ZONE });
  await chrome.send('Emulation.setLocaleOverride', { locale: 'en-US' });
  await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  assert.equal((await chrome.send('Network.setCookie', { name: 'pb_session', value: (await box.phoneSession()).token,
    url: box.origin, httpOnly: true, sameSite: 'Lax' })).success, true);
  await chrome.navigate(box.origin + '/#device=' + pending.locator + '.' + pending.secret);
  const paired = await setup.done;
  assert.equal(paired.code, 0, 'relay on --all on studio pairs the phone');
  await chrome.waitFor("document.querySelector('#phone-approvals') !== null");
  return { chrome, machineFile };
}

/** Read a card's words and whether every line of its text sits inside the card's padding. */
export function readApprovalCard(chrome, request) {
  return chrome.evaluate(`(() => {
    const card = document.querySelector('.phone-approval[data-request="${request}"]');
    const outer = card.getBoundingClientRect();
    const style = getComputedStyle(card);
    const pad = ['Left', 'Right', 'Top', 'Bottom'].map(side => parseFloat(style['padding' + side]));
    const inner = { left: outer.left + pad[0], right: outer.right - pad[1], top: outer.top + pad[2], bottom: outer.bottom - pad[3] };
    const lines = [...card.querySelectorAll('p')].flatMap(node => {
      const range = document.createRange(); range.selectNodeContents(node);
      return [...range.getClientRects()].map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
    });
    return { title: card.querySelector('.phone-approval-title')?.innerText.replace(/[\\u00a0\\u202f]/gu, ' ') ?? null,
      text: card.innerText.replace(/[\\u00a0\\u202f]/gu, ' '), pad, lines,
      inside: lines.length > 0 && lines.every(rect => rect.left >= inner.left - 0.5 && rect.right <= inner.right + 0.5 &&
        rect.top >= inner.top - 0.5 && rect.bottom <= inner.bottom + 0.5),
      action: card.querySelector('button')?.innerText ?? null };
  })()`);
}

/** The expiry as the phone in PHONE_TIME_ZONE shows it. */
export function phoneExpiry(expires) {
  return new Date(expires).toLocaleTimeString('en-US', { timeZone: PHONE_TIME_ZONE, hour: 'numeric', minute: '2-digit' }).replace(/[  ]/gu, ' ');
}
