#!/usr/bin/env node
/**
 * Rebuild the README's board screenshots and tour recording from isolated demo projects.
 * The disposable repo and private PULLBOARD_HOME keep personal projects and shouts out of the art.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser, waitForDemoBoard } from './capture-browser.mjs';
import { AGENT_SHELL_MARKERS } from '../../src/person.js';
import { renderTour } from './tour-renderer.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BIN = join(ROOT, 'bin', 'pullboard.js');
const OUTPUT = fileURLToPath(new URL('./', import.meta.url));
const DEMO_OUTPUT = join(ROOT, 'docs', 'demo');
const DEMO_BOARD_ID = 'demo-board';
const FIXED_TIME = '2026-10-06T12:00:00.000Z';
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

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

/** Model a person terminal only inside the disposable demo, with a private home and no Git overrides. */
function isolatedEnv(home, clockShim) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'NODE_OPTIONS' && !AGENT_SHELL_MARKERS.includes(key)));
  return { ...env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: home, NODE_OPTIONS: `--import ${JSON.stringify(clockShim)}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Pullboard demo', GIT_AUTHOR_EMAIL: 'demo@pullboard.invalid', GIT_COMMITTER_NAME: 'Pullboard demo', GIT_AUTHOR_DATE: FIXED_TIME, GIT_COMMITTER_DATE: FIXED_TIME };
}

/** Export the board, then replace its random storage id with a stable public snapshot id. */
async function exportBoard(repo, env) {
  await rm(DEMO_OUTPUT, { recursive: true, force: true });
  command(process.execPath, [BIN, 'view', '--export', DEMO_OUTPUT], repo, env);
  const listingPath = join(DEMO_OUTPUT, 'api', 'v1', 'boards.json');
  const listing = JSON.parse(await readFile(listingPath, 'utf8'));
  if (listing.boards.length !== 1) throw new Error('The demo export must contain exactly one board.');
  const source = join(DEMO_OUTPUT, 'api', 'v1', 'boards', listing.boards[0].id);
  const target = join(DEMO_OUTPUT, 'api', 'v1', 'boards', DEMO_BOARD_ID);
  await rename(source, target);
  listing.boards[0].id = DEMO_BOARD_ID;
  await writeFile(listingPath, JSON.stringify(listing) + '\n');
  const statePath = join(target, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.state.board = DEMO_BOARD_ID;
  await writeFile(statePath, JSON.stringify(state) + '\n');
}

/** Build the demo board by issuing real commands in a temporary git repo. */
async function buildBoard(base, env) {
  const repo = join(base, 'demo-board');
  await mkdir(repo, { recursive: true });
  command('git', ['init', '-q', '-b', 'main'], repo, env);
  command(process.execPath, [BIN, 'init'], repo, env);
  await writeFile(join(repo, 'pullboard.json'), JSON.stringify({ name: 'Demo board', project: 'Pullboard demo', gate: 'node --check src/demo.js', spec: 'SPEC.md', verify: { policy: 'any', family: 'require' }, lease: '2h', lanes: { app: { owns: ['src/'], specs: ['G'] }, review: { owns: [], specs: [] } }, shared: [] }, null, 2) + '\n');
  await writeFile(join(repo, 'SPEC.md'), '# Demo\n\n## G · Goals\n- G1 [approved, must] A demo item exists to show the board. | gate: none\n- G2 [approved, must] The verified item shows its review history. | gate: none\n');
  command('git', ['add', '-A'], repo, env);
  command('git', ['commit', '-q', '-m', 'chore: initialize demo board'], repo, env);
  const pb = (cwd, ...args) => command(process.execPath, [BIN, ...args], cwd, env);
  pb(repo, 'add', 'app', 'Reviewed and accepted', '--specs', 'G1', '--criterion', 'The demo item is accepted after review.');
  pb(repo, 'add', 'app', 'Future work', '--specs', 'G1', '--criterion', 'The board keeps another item open for later work.');
  pb(repo, 'add', 'app', 'Ready for review', '--specs', 'G1', '--criterion', 'The demo item is submitted for review.');
  pb(repo, 'add', 'app', 'Claimed for work', '--specs', 'G1', '--criterion', 'The demo item is being worked on.');
  pb(repo, 'add', 'app', 'Decision follow-up', '--specs', 'G1', '--criterion', 'The board keeps a follow-up visible after the person answers.');
  pb(repo, 'add', 'app', 'Withdrawn example', '--specs', 'G1', '--criterion', 'The demo includes withdrawn work.');
  pb(repo, 'withdraw', '6', 'this example was dropped');

  const app = pb(repo, 'worktree', 'app').match(/made (.+) on branch app\/1/)?.[1];
  if (!app) throw new Error('Could not create the demo builder worktree');
  pb(app, 'join', 'app', '--family', 'codex');
  const review = pb(repo, 'worktree', 'review').match(/made (.+) on branch review\/1/)?.[1];
  if (!review) throw new Error('Could not create the demo reviewer worktree');
  pb(review, 'join', 'review', '--family', 'claude');
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
  pb(app2, 'join', 'app', '--family', 'codex');
  pb(app2, 'claim', '3');
  await mkdir(join(app2, 'src'), { recursive: true });
  await writeFile(join(app2, 'src', 'review.js'), 'export const ready = true;\n');
  command('git', ['add', '-A'], app2, env);
  command('git', ['commit', '-q', '-m', 'feat(app): prepare the next review [G1]'], app2, env);
  pb(app2, 'submit', '3');
  const app3 = pb(repo, 'worktree', 'app').match(/made (.+) on branch app\/3/)?.[1];
  if (!app3) throw new Error('Could not create the third demo builder worktree');
  pb(app3, 'join', 'app', '--family', 'codex');
  pb(app3, 'claim', '4');
  const decision = pb(app3, 'shout', 'coordinator', 'The review is complete. May the verified change proceed?', '--decision').match(/as #(\d+)/)?.[1];
  if (!decision) throw new Error('The demo decision request was not recorded.');
  const passed = pb(repo, 'pass', decision, 'The review passed; ask the person before proceeding.').match(/as #(\d+)/)?.[1];
  if (!passed) throw new Error('The coordinator did not pass the demo decision to the person.');
  pb(repo, 'answer', passed, 'Proceed with the verified change.', '--as', 'person');
  pb(repo, 'hold', 'review', '--reason', 'Waiting for the next demo item.');
  if (!/1 withdrawn/.test(pb(repo, 'status'))) throw new Error('The demo board must include a withdrawn item.');
  const item = JSON.parse(pb(repo, 'show', '1', '--json'));
  if (item.item_builder_family !== 'codex' || item.verdicts.at(-1)?.verdict_verifier_family !== 'claude') {
    throw new Error('The accepted demo item must be verified by another declared model family.');
  }
  const doctrine = JSON.parse(pb(repo, 'spec', '--json'));
  if (!doctrine.rows.some((row) => row.origin === 'standard')) throw new Error('The demo board must include standard doctrine.');
  return repo;
}

/** Capture the tour's own terminal-paced output and encode each line with its observed delay. */
async function recordTour(env) {
  const script = process.platform === 'darwin' ? '/usr/bin/script' : '/usr/bin/script';
  const args = process.platform === 'darwin' ? ['-q', '/dev/null', process.execPath, BIN, 'tour'] : ['-q', '-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} tour`, '/dev/null'];
  const started = Date.now();
  const child = spawn(script, args, { env: { ...env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'ignore'] });
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
  await writeFile(join(OUTPUT, 'tour.svg'), renderTour(lines));
}

const tourOnly = process.argv.includes('--tour-only');
const chrome = !tourOnly && CHROME.find((path) => { try { return spawnSync(path, ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; } });
if (!chrome && !tourOnly) { process.stderr.write('pullboard demo: install Google Chrome to capture the board screenshots.\n'); process.exitCode = 1; }
else {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pullboard-readme-demo-')));
  let view;
  let server;
  try {
    const clockShim = join(base, 'fixed-clock.mjs');
    await writeFile(clockShim, `const NativeDate = Date;\nconst fixed = NativeDate.parse(${JSON.stringify(FIXED_TIME)});\nclass FixedDate extends NativeDate { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } }\nglobalThis.Date = FixedDate;\n`);
    const env = { ...isolatedEnv(join(base, '.pullboard-home'), clockShim), TMPDIR: base, TMP: base, TEMP: base };
    if (tourOnly) {
      await recordTour(env);
    } else {
      const repo = await buildBoard(base, env);
      await exportBoard(repo, env);
      server = spawn(process.execPath, [BIN, 'view', '--no-open'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'ignore'] });
      const url = await new Promise((resolveUrl, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('The demo view did not start')), 10000);
        server.stdout.setEncoding('utf8');
        server.stdout.on('data', (chunk) => { output += chunk; const match = /Pullboard view: (http:\/\/[^\s]+)/.exec(output); if (match) { clearTimeout(timer); resolveUrl(match[1]); } });
        server.once('close', () => { clearTimeout(timer); reject(new Error('The demo view stopped before it opened')); });
      });
      view = await browser(chrome, join(base, 'chrome-profile'), url);
      await waitForDemoBoard(view, repo);
      await view.viewport(1440, 700);
      await view.evaluate("document.querySelector('[data-state=all]').click()");
      await view.waitFor("!!document.querySelector('#chain .row[data-item=\"1\"]')", 'accepted item in All');
      await view.evaluate("(()=>{document.documentElement.dataset.theme='light'; localStorage.setItem('pb.theme','light'); document.querySelector('#chain .row[data-item=\"1\"]').click()})()");
      await view.waitFor("view.item === 1 && !!document.querySelector('#chain .row.on[data-item=\"1\"]') && document.querySelector('#detail').textContent.includes('Reviewed and accepted') && document.querySelector('#detail').textContent.includes('REJECT') && document.querySelector('#detail').textContent.includes('ACCEPT')", 'selected accepted item and both verdicts');
      await view.evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
      await view.screenshot(join(OUTPUT, 'desktop.png'));
      await view.viewport(390, 900);
      await view.evaluate("(()=>{document.documentElement.dataset.theme='dark'; localStorage.setItem('pb.theme','dark'); const item=document.querySelector('[data-item=\"1\"]'); const detail=document.querySelector('#detail')?.textContent??''; if(document.documentElement.dataset.theme!=='dark'||!item||!detail.includes('ACCEPT')) throw new Error('The phone screenshot must show the selected accepted item in dark mode'); return true})()");
      await view.screenshot(join(OUTPUT, 'phone.png'));
      await view.close(); view = null;
      await stop(server); server = null;
      await recordTour(env);
    }
  } finally {
    if (view) await view.close();
    if (server) await stop(server);
    await rm(base, { recursive: true, force: true });
  }
}
