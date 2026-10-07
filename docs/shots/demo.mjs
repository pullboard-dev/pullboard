#!/usr/bin/env node
/**
 * Rebuild the README's board screenshots and tour recording from isolated demo projects.
 * The disposable repo and private PULLBOARD_HOME keep personal projects and shouts out of the art.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluationValue } from './devtools-evaluation.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BIN = join(ROOT, 'bin', 'pullboard.js');
const OUTPUT = fileURLToPath(new URL('./', import.meta.url));
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));

/** Run a pullboard or git command in the disposable demo environment. */
function command(file, args, cwd, env) {
  const result = spawnSync(file, args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${file} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

/** Stop a child and wait until it has released its temporary files and sockets. */
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise((resolveStop) => child.once('close', resolveStop));
}

/** Make a child environment with a private home and no inherited git overrides. */
function isolatedEnv(home) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, HOME: home, PULLBOARD_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Pullboard demo', GIT_AUTHOR_EMAIL: 'demo@pullboard.invalid', GIT_COMMITTER_NAME: 'Pullboard demo', GIT_COMMITTER_EMAIL: 'demo@pullboard.invalid' };
}

/** Start Chrome with a disposable profile and return the DevTools connection for its page. */
async function browser(chrome, profile, url) {
  const child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1100', 'about:blank'], { stdio: 'ignore' });
  let socket;
  let port;
  try {
    for (let n = 0; n < 100 && !port; n++) {
      try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch {}
      if (!port) await pause(100);
    }
    if (!port) throw new Error('Chrome did not start');
    const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!response.ok) throw new Error('Chrome could not open the demo view');
    const target = await response.json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, fail) => { socket.addEventListener('open', ok, { once: true }); socket.addEventListener('error', fail, { once: true }); });
    let id = 0;
    const pending = new Map();
    socket.addEventListener('message', ({ data }) => { const m = JSON.parse(String(data)); const waiter = pending.get(m.id); if (waiter) { pending.delete(m.id); m.error ? waiter.reject(new Error('Chrome operation failed')) : waiter.resolve(m.result); } });
    const send = (method, params = {}) => new Promise((ok, fail) => { const key = ++id; pending.set(key, { resolve: ok, reject: fail }); socket.send(JSON.stringify({ id: key, method, params })); });
    await send('Page.enable');
    await send('Runtime.enable');
    const evaluate = async (expression) => evaluationValue(await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }));
    for (let n = 0; n < 100 && await evaluate('document.readyState') !== 'complete'; n++) await pause(100);
    return {
      evaluate,
      viewport: (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }),
      screenshot: async (path) => { const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(path, Buffer.from(result.data, 'base64')); },
      close: async () => { socket.close(); await stop(child); },
    };
  } catch (error) {
    socket?.close();
    await stop(child);
    throw error;
  }
}

/** Build the demo board by issuing real commands in a temporary git repo. */
async function buildBoard(base, env) {
  const repo = join(base, 'demo-board');
  await mkdir(repo, { recursive: true });
  command('git', ['init', '-q', '-b', 'main'], repo, env);
  command(process.execPath, [BIN, 'init'], repo, env);
  await writeFile(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'node --check src/demo.js', spec: 'SPEC.md', verify: 'any', lease: '2h', lanes: { app: { owns: ['src/'], specs: ['G'] }, review: { owns: [], specs: [] } }, shared: [] }, null, 2) + '\n');
  await writeFile(join(repo, 'SPEC.md'), '# Demo\n\n## G · Goals\n- G1 [approved, must] A demo item exists to show the board. | gate: none\n');
  command('git', ['add', '-A'], repo, env);
  command('git', ['commit', '-q', '-m', 'chore: initialize demo board'], repo, env);
  const pb = (cwd, ...args) => command(process.execPath, [BIN, ...args], cwd, env);
  pb(repo, 'add', 'app', 'Reviewed and accepted', '--specs', 'G1', '--criterion', 'The demo item is accepted after review.');
  pb(repo, 'add', 'app', 'Open for rework', '--specs', 'G1', '--criterion', 'The demo item remains open after rejection.');
  pb(repo, 'add', 'app', 'Ready for review', '--specs', 'G1', '--criterion', 'The demo item is submitted for review.');
  pb(repo, 'add', 'app', 'Claimed for work', '--specs', 'G1', '--criterion', 'The demo item is being worked on.');
  pb(repo, 'add', 'app', 'Open decision', '--specs', 'G1', '--criterion', 'The demo has a pending decision.');
  pb(repo, 'add', 'app', 'Withdrawn example', '--specs', 'G1', '--criterion', 'The demo includes withdrawn work.');
  pb(repo, 'withdraw', '6', 'this example was dropped');

  const app = pb(repo, 'worktree', 'app').match(/made (.+) on branch app\/1/)?.[1];
  if (!app) throw new Error('Could not create the demo builder worktree');
  const review = pb(repo, 'worktree', 'review').match(/made (.+) on branch review\/1/)?.[1];
  if (!review) throw new Error('Could not create the demo reviewer worktree');
  pb(app, 'next');
  await mkdir(join(app, 'src'), { recursive: true });
  await writeFile(join(app, 'src', 'demo.js'), 'export const reviewed = false;\n');
  command('git', ['add', '-A'], app, env);
  command('git', ['commit', '-q', '-m', 'feat(app): draft the demo change [G1]'], app, env);
  pb(app, 'submit', '1');
  const first = command('git', ['rev-parse', 'HEAD'], app, env);
  command('git', ['switch', '-q', '--detach', first], review, env);
  pb(review, 'verify', '1', 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--note', 'The example skipped an edge; revise it before merging.');
  pb(app, 'claim', '1');
  await writeFile(join(app, 'src', 'demo.js'), 'export const reviewed = true;\n');
  command('git', ['add', '-A'], app, env);
  command('git', ['commit', '-q', '-m', 'feat(app): revise the reviewed demo [G1]'], app, env);
  pb(app, 'submit', '1');
  const second = command('git', ['rev-parse', 'HEAD'], app, env);
  command('git', ['switch', '-q', '--detach', second], review, env);
  pb(review, 'verify', '1', 'accept', '--note', 'Tried the edge that failed before; the revised demo passes.');
  command('git', ['merge', '-q', '--ff-only', 'app/1'], repo, env);
  pb(repo, 'merged', '1', second);
  const app2 = pb(repo, 'worktree', 'app').match(/made (.+) on branch app\/2/)?.[1];
  if (!app2) throw new Error('Could not create the second demo builder worktree');
  pb(app2, 'claim', '3');
  await mkdir(join(app2, 'src'), { recursive: true });
  await writeFile(join(app2, 'src', 'review.js'), 'export const ready = true;\n');
  command('git', ['add', '-A'], app2, env);
  command('git', ['commit', '-q', '-m', 'feat(app): prepare the next review [G1]'], app2, env);
  pb(app2, 'submit', '3');
  const app3 = pb(repo, 'worktree', 'app').match(/made (.+) on branch app\/3/)?.[1];
  if (!app3) throw new Error('Could not create the third demo builder worktree');
  pb(app3, 'claim', '4');
  pb(repo, 'shout', 'app', 'Decision needed: should this change wait for another reviewer?', '--decision');
  pb(repo, 'shout', 'all', 'Demo receipt: the fixture is isolated and the accepted revision was checked.', '--evidence', 'receipt', '--outcome', 'accepted', '--item', '1', '--commit', second);
  if (!/1 withdrawn/.test(pb(repo, 'status'))) throw new Error('The demo board must include a withdrawn item.');
  return repo;
}

/** Capture the tour's own terminal-paced output and encode each line with its observed delay. */
async function recordTour(env) {
  const script = process.platform === 'darwin' ? '/usr/bin/script' : '/usr/bin/script';
  const args = process.platform === 'darwin' ? ['-q', '/dev/null', process.execPath, BIN, 'tour'] : ['-q', '-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} tour`, '/dev/null'];
  const started = Date.now();
  const child = spawn(script, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let buffer = '';
  const lines = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk.replaceAll('\r', '');
    const parts = buffer.split('\n');
    buffer = parts.pop();
    for (const text of parts) if (text) lines.push({ text, at: Date.now() - started });
  });
  const status = await new Promise((resolveStatus) => child.once('close', resolveStatus));
  if (buffer.trim()) lines.push({ text: buffer.trim(), at: Date.now() - started });
  if (status !== 0 || !lines.length) throw new Error('The pullboard tour recording did not finish');
  const shown = lines.map(({ text, at }) => ({ text: text.replaceAll('^D\b\b', '').replace(/[\x00-\x08\x0b-\x1f]/g, ''), at }));
  const height = Math.max(480, shown.length * 22 + 56);
  const contents = shown.map(({ text, at }, index) => `<text x="24" y="${42 + index * 22}" opacity="0">${escapeXml(text.replace(/^.*Look around: cd .*/, '   Look around: cd greeter && pullboard log').slice(0, 132))}<animate attributeName="opacity" from="0" to="1" begin="${(at / 1000).toFixed(2)}s" dur="0.12s" fill="freeze"/></text>`).join('\n');
  const duration = ((lines.at(-1).at + 4000) / 1000).toFixed(2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 ${height}" role="img" aria-label="Pullboard tour: a reviewed change is rejected, fixed and accepted"><rect width="100%" height="100%" rx="16" fill="#101820"/><g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14" fill="#e6edf3">${contents}</g><rect x="0" y="0" width="960" height="${height}" fill="transparent"><animate attributeName="opacity" from="1" to="1" begin="${duration}s" dur="0.1s" fill="freeze"/></rect></svg>`;
  await writeFile(join(OUTPUT, 'tour.svg'), svg);
}

/** XML-escape terminal output before embedding it in an SVG text node. */
function escapeXml(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }

const chrome = CHROME.find((path) => { try { return spawnSync(path, ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; } });
if (!chrome) { process.stderr.write('pullboard demo: install Google Chrome to capture the board screenshots.\n'); process.exitCode = 1; }
else {
  const base = await mkdtemp(join(tmpdir(), 'pullboard-readme-demo-'));
  let view;
  let server;
  try {
    const env = isolatedEnv(join(base, '.pullboard-home'));
    const repo = await buildBoard(base, env);
    server = spawn(process.execPath, [BIN, 'view', '--no-open'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'ignore'] });
    const url = await new Promise((resolveUrl, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('The demo view did not start')), 10000);
      server.stdout.setEncoding('utf8');
      server.stdout.on('data', (chunk) => { output += chunk; const match = /Pullboard view: (http:\/\/[^\s]+)/.exec(output); if (match) { clearTimeout(timer); resolveUrl(match[1]); } });
      server.once('close', () => { clearTimeout(timer); reject(new Error('The demo view stopped before it opened')); });
    });
    view = await browser(chrome, join(base, 'chrome-profile'), url);
    await pause(700);
    await view.viewport(1440, 700);
    const detail = await view.evaluate("(()=>{document.documentElement.dataset.theme='light'; localStorage.setItem('pb.theme','light'); document.querySelector('[data-state=all]')?.click(); const item=document.querySelector('[data-item=\"1\"]'); if(!item) throw new Error('accepted item #1 is missing'); item.click(); return document.querySelector('#detail').textContent})()");
    if (!detail.includes('REJECT') || !detail.includes('ACCEPT')) throw new Error('The desktop screenshot must show item #1 rejected and accepted.');
    await pause(350);
    await view.screenshot(join(OUTPUT, 'desktop.png'));
    await view.viewport(390, 900);
    await view.evaluate("(()=>{document.documentElement.dataset.theme='dark'; localStorage.setItem('pb.theme','dark'); const item=document.querySelector('[data-item=\"1\"]'); const detail=document.querySelector('#detail')?.textContent??''; if(document.documentElement.dataset.theme!=='dark'||!item||!detail.includes('ACCEPT')) throw new Error('The phone screenshot must show the selected accepted item in dark mode'); return true})()");
    await view.screenshot(join(OUTPUT, 'phone.png'));
    await view.close(); view = null;
    await stop(server); server = null;
    await recordTour(env);
  } finally {
    if (view) await view.close();
    if (server) await stop(server);
    await rm(base, { recursive: true, force: true });
  }
}
