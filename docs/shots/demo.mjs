#!/usr/bin/env node
/**
 * Rebuild the README's board screenshots and tour recording from isolated demo projects.
 * The disposable repo and private PULLBOARD_HOME keep personal projects and shouts out of the art.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser, waitForDemoBoard } from './capture-browser.mjs';
import { FIXED_TIME, isolatedEnv } from './demo-env.mjs';
import { renderTour } from './tour-renderer.mjs';
import { themeVariants } from '../img/theme.mjs';
import { AGENT_SHELL_MARKERS } from '../../packages/kernel/index.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BIN = join(ROOT, 'apps', 'cli', 'pullboard.js');
const OUTPUT = fileURLToPath(new URL('./', import.meta.url));
/** Every board image is captured in both themes, so GitHub can show the one that matches the reader. */
const THEMES = ['light', 'dark'];
const DEMO_OUTPUT = join(ROOT, 'docs', 'demo');
const DEMO_BOARD_ID = 'demo-board';
const CHROME = [process.env.PULLBOARD_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);

/** Set the deterministic lifecycle clock used by the next isolated board command. */
function setDemoMinutes(env, minutes) {
  env.PULLBOARD_DEMO_NOW = new Date(Date.parse(FIXED_TIME) + minutes * 60_000).toISOString();
}

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

/** Read one process identity without capturing its environment or application data. */
function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  const result = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const fields = result.stdout.trim().split(/\s+/);
  if (fields.length < 9 || Number(fields[0]) !== pid) return null;
  const identity = { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), birth: fields.slice(3, 8).join(' '), command: fields.slice(8).join(' ') };
  if (process.platform === 'linux') {
    try { identity.cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { identity.cwd = null; }
  } else if (process.platform === 'darwin') {
    const cwd = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    identity.cwd = cwd.status === 0 ? cwd.stdout.split(/\r?\n/).find((line) => line.startsWith('n'))?.slice(1) ?? null : null;
  } else identity.cwd = null;
  return identity;
}

/** List fixture-owned command lines while the temporary directory still exists. */
function fixtureProcessIdentities(directory, knownViewPid) {
  const result = spawnSync('ps', ['-ww', '-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`could not inspect processes for the README capture (ps status ${result.status})`);
  return result.stdout.split(/\r?\n/).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    const pid = Number(fields[0]);
    if (!Number.isInteger(pid) || pid < 1 || pid === process.pid || fields.length < 9) return [];
    const identity = { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), birth: fields.slice(3, 8).join(' '), command: fields.slice(8).join(' ') };
    if (!identity.command.includes(directory) && identity.pid !== knownViewPid) return [];
    return [{ ...identity, cwd: processIdentity(identity.pid)?.cwd ?? null }];
  });
}

/** In the opt-in test receipt only, stop the one exact view PID this capture reported. */
async function stopObservedView(observation) {
  const record = observation.viewBeforeStop;
  const current = processIdentity(observation.viewPid);
  const cleanup = { attempted: false, pid: observation.viewPid ?? null, signal: null, exited: current === null, refused: null };
  if (!current) return cleanup;
  if (!record || current.birth !== record.birth || current.command !== record.command
    || !current.command.includes(observation.entrypoint)
    || !/\bview\s+--no-open\s+--port\s+0(?:\s|$)/.test(current.command)
    || current.cwd !== record.cwd || record.cwd !== observation.repo) {
    cleanup.refused = 'the live PID did not match the recorded fixture view identity';
    cleanup.exited = false;
    return cleanup;
  }
  cleanup.attempted = true;
  cleanup.signal = 'SIGTERM';
  try { process.kill(current.pid, 'SIGTERM'); }
  catch (error) { cleanup.refused = `${error.code ?? error.name}: could not signal recorded view PID`; cleanup.exited = false; return cleanup; }
  const deadline = Date.now() + 5_000;
  let stillLive = processIdentity(current.pid);
  while (stillLive && Date.now() < deadline) {
    if (stillLive.birth !== record.birth || stillLive.command !== record.command) {
      cleanup.refused = 'the PID identity changed during bounded cleanup';
      cleanup.exited = false;
      return cleanup;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    stillLive = processIdentity(current.pid);
  }
  cleanup.exited = stillLive === null;
  if (!cleanup.exited) cleanup.refused = 'the exact view PID remained after bounded SIGTERM cleanup';
  return cleanup;
}

/** Record all fixture processes and the exact view identity before the ordinary stop. */
function recordBeforeViewStop(observation) {
  if (!observation || observation.fixtureProcessesBeforeStop) return;
  observation.viewBeforeStop = processIdentity(observation.viewPid);
  observation.fixtureProcessesBeforeStop = fixtureProcessIdentities(observation.demoDirectory, observation.viewPid);
}

/** Record ordinary-stop survivors, apply only the owned test cleanup, then rescan. */
async function recordAfterViewStop(observation) {
  if (!observation || observation.fixtureProcessesAfterStop) return;
  observation.viewAfterStop = processIdentity(observation.viewPid);
  // The Chrome guardian polls every 250 ms and exits once Chrome's group is gone, so give it a few seconds to notice.
  let survivors = fixtureProcessIdentities(observation.demoDirectory, observation.viewPid);
  for (let waited = 0; survivors.length && waited < 5000; waited += 100) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    survivors = fixtureProcessIdentities(observation.demoDirectory, observation.viewPid);
  }
  observation.fixtureProcessesAfterStop = survivors;
  observation.testCleanup = await stopObservedView(observation);
  observation.fixtureProcessesAfterTestCleanup = fixtureProcessIdentities(observation.demoDirectory, observation.viewPid);
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
  command(process.execPath, [BIN, 'init', '--model', 'Demo coordinator'], repo, env);
  await writeFile(join(repo, 'pullboard.json'), JSON.stringify({ name: 'Demo board', project: 'Demo project', gate: 'node --check src/demo.js', spec: 'SPEC.md', verify: { policy: 'any', family: 'require' }, lease: '2h', lanes: { app: { owns: ['src/'], specs: ['G'] }, review: { owns: [], specs: [] } }, shared: [] }, null, 2) + '\n');
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

  const app = pb(repo, 'worktree', 'app', '--model', 'Demo builder').match(/made (.+) on branch app\/1/)?.[1];
  if (!app) throw new Error('Could not create the demo builder worktree');
  pb(app, 'join', 'app', '--family', 'codex', '--model', 'Demo builder');
  const review = pb(repo, 'worktree', 'review', '--model', 'Demo reviewer').match(/made (.+) on branch review\/1/)?.[1];
  if (!review) throw new Error('Could not create the demo reviewer worktree');
  pb(review, 'join', 'review', '--family', 'claude', '--model', 'Demo reviewer');
  setDemoMinutes(env, 1);
  pb(app, 'next');
  await mkdir(join(app, 'src'), { recursive: true });
  await writeFile(join(app, 'src', 'demo.js'), 'export const reviewed = false;\n');
  command('git', ['add', '-A'], app, env);
  command('git', ['commit', '-q', '-m', 'feat(app): draft the demo change [G1]'], app, env);
  setDemoMinutes(env, 2);
  pb(app, 'submit', '1', '--no-next');
  const first = command('git', ['rev-parse', 'HEAD'], app, env);
  command('git', ['switch', '-q', '--detach', first], review, env);
  setDemoMinutes(env, 3);
  pb(review, 'next', '--verify');
  setDemoMinutes(env, 4);
  pb(review, 'verify', '1', 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--clause', 'The demo item is accepted after review.', '--note', 'The example skipped an edge; revise it before merging.');
  setDemoMinutes(env, 5);
  pb(app, 'claim', '1');
  await writeFile(join(app, 'src', 'demo.js'), 'export const reviewed = true;\n');
  command('git', ['add', '-A'], app, env);
  command('git', ['commit', '-q', '-m', 'feat(app): revise the reviewed demo [G1]'], app, env);
  setDemoMinutes(env, 6);
  pb(app, 'submit', '1', '--no-next');
  const second = command('git', ['rev-parse', 'HEAD'], app, env);
  command('git', ['switch', '-q', '--detach', second], review, env);
  setDemoMinutes(env, 12);
  pb(review, 'next', '--verify');
  setDemoMinutes(env, 13);
  pb(review, 'verify', '1', 'accept', '--note', 'Tried the edge that failed before: edge passes in the revised demo.');
  setDemoMinutes(env, 14);
  command('git', ['merge', '-q', '--ff-only', 'app/1'], repo, env);
  pb(repo, 'merged', '1', second);
  command('git', ['switch', '-q', '-c', 'app/next-review', 'main'], app, env);
  pb(app, 'claim', '3');
  await writeFile(join(app, 'src', 'review.js'), 'export const ready = true;\n');
  command('git', ['add', '-A'], app, env);
  command('git', ['commit', '-q', '-m', 'feat(app): prepare the next review [G1]'], app, env);
  pb(app, 'submit', '3', '--no-next');
  pb(app, 'claim', '4');
  setDemoMinutes(env, 75);
  pb(repo, 'lanes', 'lead', 'app', 'app-1');
  const decision = pb(app, 'shout', 'coordinator', 'The review is complete. May the verified change proceed?', '--decision', '--kind', 'decision').match(/as #(\d+)/)?.[1];
  if (!decision) throw new Error('The demo decision request was not recorded.');
  const passed = pb(repo, 'pass', decision, 'The review passed; ask the person before proceeding.').match(/as #(\d+)/)?.[1];
  if (!passed) throw new Error('The coordinator did not pass the demo decision to the person.');
  pb(repo, 'answer', passed, 'Proceed with the verified change.', '--as', 'person');
  pb(repo, 'inbox');
  pb(app, 'inbox');
  pb(repo, 'shout', 'app-1', '#4 can continue while #3 waits for review.');
  pb(repo, 'hold', 'review', '--reason', 'Waiting for the next demo item.');
  pb(repo, 'milestone', 'add', 'Demo release', '--items', '1,2,3,4,5', '--note', 'A demo release with reviewed, active and future work.', '--reason', 'The demo release groups the demo items.');
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
  const { light, dark } = themeVariants(renderTour(lines));
  await writeFile(join(OUTPUT, 'tour.svg'), light);
  await writeFile(join(OUTPUT, 'tour-dark.svg'), dark);
}

/**
 * Show the board in one theme the way the reader's own choice does, then wait for the paint.
 *
 * @param {{ evaluate: (expression: string) => Promise<unknown> }} view the open demo page
 * @param {'light' | 'dark'} theme the theme to paint
 */
async function paintTheme(view, theme) {
  await view.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; localStorage.setItem('pb.theme', ${JSON.stringify(theme)})`);
  await view.evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
}

/** Capture the real demo release and one expanded item, with data and geometry checks before each image. */
async function captureRoadmap(view, repo, observation) {
  const output = join(ROOT, 'docs', 'img');
  await mkdir(output, { recursive: true });
  await view.viewport(1440, 1000);
  await view.evaluate("document.querySelector('[data-tab=roadmap]').click()");
  await view.waitFor(`view.tab === 'roadmap' && data.project.root === ${JSON.stringify(repo)} && document.querySelector('[data-key="m:Demo release"]')`, 'the isolated demo release');
  await view.evaluate(`(() => {
    const release = document.querySelector('[data-key="m:Demo release"]');
    const head = release.querySelector('.milestone-head');
    if (head.getAttribute('aria-expanded') !== 'true') head.click();
    return true;
  })()`);
  await view.waitFor("document.querySelector('[data-key=\"m:Demo release\"] .milestone-item[data-roadmap-key=\"i:#1\"]')", 'the demo release items');
  await view.evaluate(`(() => {
    const release = document.querySelector('[data-key="m:Demo release"]');
    for (const row of release.querySelectorAll('.milestone-item[aria-expanded="true"]')) row.click();
    release.querySelector('.milestone-item[data-roadmap-key="i:#1"]').click();
    return true;
  })()`);
  await view.waitFor(`(() => {
    const release = document.querySelector('[data-key="m:Demo release"]');
    const row = release?.querySelector('.milestone-item[data-roadmap-key="i:#1"]');
    const fields = [...(row?.parentElement.querySelectorAll('.roadmap-detail dt') || [])].map(node => node.textContent.trim());
    return row?.getAttribute('aria-expanded') === 'true' && ['Criterion', 'Agents', 'History', 'Release'].every(name => fields.includes(name))
      && !!release.querySelector('.roadmap-estimate')?.textContent;
  })()`, 'the expanded item fields and current time feedback');
  const readings = [];
  for (const theme of ['light', 'dark']) {
    await view.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; localStorage.setItem('pb.theme', ${JSON.stringify(theme)})`);
    await view.evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
    const reading = JSON.parse(await view.evaluate(`JSON.stringify((() => {
      const release = document.querySelector('[data-key="m:Demo release"]');
      const row = release.querySelector('.milestone-item[data-roadmap-key="i:#1"]');
      const rect = row.parentElement.getBoundingClientRect();
      return { theme: document.documentElement.dataset.theme, width: innerWidth, height: innerHeight,
        count: release.querySelector('.roadmap-left')?.textContent, legend: release.querySelectorAll('[data-summary-state]').length,
        rows: release.querySelectorAll('.milestone-item').length, expanded: release.querySelectorAll('.milestone-item[aria-expanded="true"]').length,
        fields: [...row.parentElement.querySelectorAll('.roadmap-detail dt')].map(node => node.textContent.trim()),
        history: row.parentElement.querySelector('.roadmap-history')?.textContent, time: release.querySelector('.roadmap-estimate')?.textContent,
        itemTop: rect.top, itemBottom: rect.bottom, pageWidth: document.documentElement.scrollWidth };
    })())`));
    if (reading.theme !== theme || !/4 to go.*1 of 5 landed/u.test(reading.count) || reading.legend !== 6 || reading.rows !== 5 || reading.expanded !== 1
      || !reading.history?.includes('sent back') || !reading.history?.includes('accepted') || !reading.time
      || reading.itemTop < 0 || reading.itemBottom > reading.height || reading.pageWidth > reading.width) {
      throw new Error('The demo Roadmap capture is incomplete: ' + JSON.stringify(reading));
    }
    readings.push(reading);
    await view.screenshot(join(output, 'roadmap-' + theme + '.png'));
  }
  if (observation) observation.roadmap = readings;
}

const boardOnly = process.argv.includes('--board-only');
const screenshotsOnly = process.argv.includes('--screenshots-only');
const roadmapOnly = process.argv.includes('--roadmap-only');
const tourOnly = process.argv.includes('--tour-only');
const chrome = !tourOnly && !boardOnly && CHROME.find((path) => { try { return spawnSync(path, ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; } });
if (!chrome && !tourOnly && !boardOnly) { process.stderr.write('pullboard demo: install Google Chrome to capture the board screenshots.\n'); process.exitCode = 1; }
else {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rd-')));
  let view;
  let server;
  const observationPath = process.env.PULLBOARD_README_CAPTURE_OBSERVATION_PATH;
  const requestedForeground = process.env.PULLBOARD_README_CAPTURE_FOREGROUND === '1';
  const observation = observationPath ? {
    arm: requestedForeground ? 'foreground-control' : 'unchanged-default',
    startedAt: new Date().toISOString(),
    demoDirectory: base,
    repo: join(base, 'demo-board'),
    entrypoint: BIN,
    sourceEnv: {
      aiAgentPresent: process.env.AI_AGENT !== undefined,
      requestedForeground,
    },
  } : null;
  try {
    const clockShim = join(base, 'fixed-clock.mjs');
    await writeFile(clockShim, `const NativeDate = Date;\nconst fixed = NativeDate.parse(process.env.PULLBOARD_DEMO_NOW || ${JSON.stringify(FIXED_TIME)});\nclass FixedDate extends NativeDate { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } }\nglobalThis.Date = FixedDate;\n`);
    const env = { ...isolatedEnv(join(base, '.pullboard-home'), clockShim), PULLBOARD_DEMO_NOW: FIXED_TIME, TMPDIR: base, TMP: base, TEMP: base };
    if (tourOnly) {
      await recordTour(env);
    } else {
      const repo = await buildBoard(base, env);
      await exportBoard(repo, env);
      if (!boardOnly) {
        const viewEnv = { ...env };
        delete viewEnv.PULLBOARD_README_CAPTURE_FOREGROUND;
        delete viewEnv.PULLBOARD_README_CAPTURE_OBSERVATION_PATH;
        delete viewEnv.PULLBOARD_README_CAPTURE_EVIDENCE_DIR;
        viewEnv.PULLBOARD_VIEW_FOREGROUND = '1';
        server = spawn(process.execPath, [BIN, 'view', '--no-open', '--port', '0'], { cwd: repo, env: viewEnv, stdio: ['ignore', 'pipe', 'ignore'] });
        if (observation) {
          observation.viewLaunch = {
            directPid: server.pid,
            cwd: repo,
            stdoutIsTTY: Boolean(server.stdout?.isTTY),
            foregroundEnv: viewEnv.PULLBOARD_VIEW_FOREGROUND === '1',
            aiAgentPresent: viewEnv.AI_AGENT !== undefined,
            agentMarkersPresent: AGENT_SHELL_MARKERS.some((name) => viewEnv[name] !== undefined),
          };
        }
        const url = await new Promise((resolveUrl, reject) => {
          let output = '';
          let pageUrl;
          const timer = setTimeout(() => reject(new Error('The demo view did not start')), 10000);
          const resolveWhenReady = () => {
            if (pageUrl && (!observation || observation.viewPid)) {
              if (observation) observation.viewOutput = output.replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/g, '$1?[redacted]');
              clearTimeout(timer);
              resolveUrl(pageUrl);
            }
          };
          server.stdout.setEncoding('utf8');
          server.stdout.on('data', (chunk) => {
            output += chunk;
            const match = /Pullboard view: (http:\/\/[^\s]+)/.exec(output);
            const pid = /To stop it: (?:kill|taskkill \/PID) (\d+)/.exec(output);
            if (pid && observation) observation.viewPid = Number(pid[1]);
            if (match) pageUrl = match[1];
            resolveWhenReady();
          });
          server.once('close', () => { clearTimeout(timer); reject(new Error('The demo view stopped before it opened')); });
        });
        if (observation) {
          observation.viewLaunch.actualViewPid = observation.viewPid ?? null;
          observation.viewLaunch.branch = observation.viewPid === server.pid ? 'foreground' : observation.viewPid ? 'background' : 'unknown';
          observation.viewLaunch.reportedIdentity = processIdentity(observation.viewPid);
        }
        view = await browser(chrome, join(base, 'chrome-profile'), url);
        await view.evaluate("document.querySelector('[data-tab=\"items\"]').click()");
        await waitForDemoBoard(view, repo);
        if (!roadmapOnly) {
          await view.viewport(1440, 900);
          await view.evaluate("document.querySelector('#filter-toggle').click(); document.querySelector('#filter-menu [data-filter-choice=\"state:all\"]').click()");
          await view.waitFor("!!document.querySelector('#chain .row[data-item=\"1\"]')", 'accepted item in All');
          await view.evaluate("(()=>{document.documentElement.dataset.theme='light'; localStorage.setItem('pb.theme','light'); document.querySelector('#chain .row[data-item=\"1\"]').click()})()");
          await view.waitFor("view.item === 1 && !!document.querySelector('#chain .row.on[data-item=\"1\"]') && document.querySelector('#detail').textContent.includes('Reviewed and accepted')", 'selected accepted item');
          await view.waitFor("!!document.querySelector('#item-panel-tab-verdicts')", 'verdicts tab');
          await view.evaluate("document.querySelector('#item-panel-tab-verdicts').click()");
          await view.waitFor("document.querySelector('#detail').textContent.includes('The example skipped an edge') && document.querySelector('#detail').textContent.includes('edge passes')", 'both verdicts');
          await view.evaluate("document.querySelector('#filter-toggle').click(); document.querySelector('#filter-menu [data-filter-choice=\"state:active\"]').click()");
          await view.waitFor("!document.querySelector('#needs').hidden && document.querySelector('#needs').textContent.includes('Questions and sentinels') && document.querySelector('#detail').textContent.includes('edge passes')", 'Active items, Questions and sentinels and the selected review history');
          await view.evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
          for (const theme of THEMES) {
            await paintTheme(view, theme);
            await view.screenshot(join(OUTPUT, `desktop-${theme}.png`));
          }
          await view.viewport(390, 900);
          for (const theme of THEMES) {
            await paintTheme(view, theme);
            await view.evaluate("(()=>{const item=document.querySelector('[data-item=\"4\"]'); const detail=document.querySelector('#detail')?.textContent??''; if(!item||!detail.includes('edge passes')||document.querySelector('#needs').hidden) throw new Error('The phone screenshot must show active work and Needs you'); return true})()");
            await view.screenshot(join(OUTPUT, `phone-${theme}.png`));
          }
          await view.viewport(1440, 900);
          await view.evaluate("document.documentElement.dataset.theme='light'; localStorage.setItem('pb.theme','light'); document.querySelector('[data-tab=\"shouts\"]').click()");
          await view.waitFor("!document.querySelector('#shouts-pane').hidden && document.querySelectorAll('#feed .conversation-row').length >= 3", 'the answered conversation list');
          for (const theme of THEMES) {
            await paintTheme(view, theme);
            await view.screenshot(join(OUTPUT, `shouts-${theme}.png`));
          }
        }
        await captureRoadmap(view, repo, observation);
        await view.close(); view = null;
        recordBeforeViewStop(observation);
        await stop(server); server = null;
        await recordAfterViewStop(observation);
        if (!screenshotsOnly && !roadmapOnly) await recordTour(env);
        if (observation) observation.outcome = 'completed';
      }
    }
  } finally {
    const teardownErrors = [];
    if (view) {
      try { await view.close(); } catch (error) { teardownErrors.push(`${error.name}: browser close failed`); }
      view = null;
    }
    try { recordBeforeViewStop(observation); } catch (error) { teardownErrors.push(`${error.name}: pre-stop process snapshot failed`); }
    if (server) {
      try { await stop(server); } catch (error) { teardownErrors.push(`${error.name}: view launcher stop failed`); }
      server = null;
    }
    try { await recordAfterViewStop(observation); } catch (error) { teardownErrors.push(`${error.name}: post-stop process snapshot failed`); }
    if (observation) {
      observation.teardownErrors = teardownErrors;
      observation.finishedAt = new Date().toISOString();
      try { await writeFile(observationPath, `${JSON.stringify(observation, null, 2)}\n`, { mode: 0o600 }); }
      catch (error) { teardownErrors.push(`${error.name}: observation receipt write failed`); }
    }
    if (teardownErrors.length) process.exitCode = 1;
    await rm(base, { recursive: true, force: true });
  }
}
