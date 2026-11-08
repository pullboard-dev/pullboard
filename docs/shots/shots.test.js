// pullboard: browser
/** @pullboard-test-gui */
/**
 * The README's screenshots and timed tour recording (I11, I13) are reproducible demo artifacts,
 * and fit the size budgets so they stay useful in the README and the site.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, posix } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluationValue } from './devtools-evaluation.mjs';
import { renderTour } from './tour-renderer.mjs';
import { themeVariants } from '../img/theme.mjs';
import { narrationDurations, parseVtt } from './video.mjs';

const ROOT = new URL('../../', import.meta.url);
const README = readFileSync(new URL('README.md', ROOT), 'utf8');
const files = ['desktop-light.png', 'desktop-dark.png', 'phone-light.png', 'phone-dark.png', 'shouts-light.png', 'shouts-dark.png', 'tour.svg', 'tour-dark.svg'];
const shots = (name) => new URL(`docs/shots/${name}`, ROOT);

/**
 * Assert that a README picture embeds a named capture in a section, with descriptive alt text and a dark twin.
 *
 * @param {string} section the README section heading that holds the picture
 * @param {string} file the light capture's file name under docs/shots
 * @param {string[]} phrases words the alt text must include
 */
function linkedInSection(section, file, phrases) {
  const start = README.indexOf(`## ${section}`);
  assert.notEqual(start, -1, `README has the ${section} section`);
  const next = README.indexOf('\n## ', start + 1);
  const body = README.slice(start, next < 0 ? undefined : next);
  const light = `docs/shots/${file.replaceAll('.', '\\.')}`;
  const match = new RegExp(`<img src="${light}" alt="([^"]+)">`).exec(body);
  assert.ok(match, `${file} is embedded in ${section}`);
  const dark = file === 'tour.svg' ? 'tour-dark.svg' : file.replace('-light.', '-dark.');
  assert.ok(body.includes(`srcset="docs/shots/${dark}"`), `${file} has a dark twin in ${section}`);
  for (const phrase of phrases) assert.ok(match[1].toLowerCase().includes(phrase), `${file} alt text says ${phrase}`);
}

test('the README links the desktop board and timed tour with descriptive alt text [I11,I13]', () => {
  linkedInSection('Pullboard View', 'desktop-light.png', ['open', 'claimed', 'submitted', 'accepted']);
  linkedInSection('Installation', 'tour.svg', ['submitted', 'rejected', 'fixed', 'accepted']);
});

test('the README board shots show the stats line [I11,I13]', () => {
  const { state } = JSON.parse(readFileSync(new URL('docs/demo/api/v1/boards/demo-board/state.json', ROOT), 'utf8'));
  const stats = state.proofStats;
  assert.equal(stats.merged, 1, 'the demo includes one merged item');
  assert.equal(stats.rejectionShare, 1 / 3, 'one of three submissions was sent back');
  assert.equal(stats.flow.stages.reviewWait.totalMinutes, 6, 'the final review wait is recorded as six minutes');
  assert.equal(stats.flow.bottleneck.fullyMeasuredCycles, 1, 'the completed demo cycle has every stage measured');
  assert.equal(stats.flow.bottleneck.stage, 'reviewWait', 'recorded event times name the longest completed-cycle stage');
  assert.equal(stats.flow.bottleneck.recommendation, 'add a verifier');
  const exported = readFileSync(new URL('docs/demo/index.html', ROOT), 'utf8');
  assert.match(exported, /proof-stats-summary-text/, 'the exported demo renders a compact summary');
  assert.match(exported, /stats\.merged \+ ' merged · ' \+ percentage \+ ' sent back'/, 'the summary is derived from exported stats');
  assert.match(exported, /Bottleneck: ' \+ \(stage \|\| bottleneck\.message\)/, 'the summary includes the measured bottleneck');
  linkedInSection('Pullboard View', 'desktop-light.png', ['stats line', 'merged work', 'sent-back share', 'bottleneck recommendation']);
  linkedInSection('Pullboard View', 'phone-light.png', ['stats line', 'merged work', 'sent-back share', 'bottleneck recommendation']);
});

test('the demo board stages a Shouts conversation [I11,I13]', () => {
  const { state } = JSON.parse(readFileSync(new URL('docs/demo/api/v1/boards/demo-board/state.json', ROOT), 'utf8'));
  const agents = state.agents.filter((agent) => agent.agent_id !== 'person');
  assert.equal(agents.length, 3, 'the demo has a coordinator, builder and reviewer');
  const senders = new Set(state.shouts.map((shout) => shout.shout_from).filter((id) => id !== 'person'));
  assert.deepEqual([...senders].sort(), ['app-1', 'coordinator']);
  const decision = state.shouts.find((shout) => shout.shout_decision && shout.shout_to === 'person');
  assert.ok(decision, 'the coordinator asks the person');
  const answer = state.shouts.find((shout) => shout.shout_from === 'person' && shout.shout_answers === decision.shout_id);
  assert.ok(answer, 'the person answers that decision');
  assert.ok(agents.some((agent) => ['all', agent.agent_id, agent.agent_lane].includes(answer.shout_to)
    && agent.agent_last_shout_id >= answer.shout_id), 'an addressed agent has Heard the person');
  const reviewed = state.items.find((item) => item.id === 1);
  const accept = reviewed.verdicts.find((verdict) => verdict.by === 'review-1' && verdict.decision === 'ACCEPT');
  assert.ok(accept, 'the board records review-1\'s accept verdict on the reviewed item');
  assert.equal(accept.commit, reviewed.commit, 'the accept is at the reviewed commit');
  assert.match(accept.note, /edge passes/, 'the recorded verdict note proves the outcome');
});

test('the demo board declares every agent\'s model [I11,I13]', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'pullboard-demo-model-'));
  try {
    const source = fileURLToPath(ROOT);
    const root = join(fixture, 'repo');
    mkdirSync(root);
    for (const directory of ['apps', 'packages', 'src', 'bin', 'docs/shots', 'docs/img', 'skills']) cpSync(join(source, directory), join(root, directory), { recursive: true });
    for (const file of ['test/chrome-fixture.js', 'test/chrome-graceful-shutdown.js', 'test/chrome-launch-args.js', 'test/fixture-child.js', 'package.json', 'CHANGELOG.md']) cpSync(join(source, file), join(root, file));
    const shims = join(fixture, 'bin');
    mkdirSync(shims);
    const pullboard = join(shims, 'pullboard');
    writeFileSync(pullboard, `#!/bin/sh\nexec "${process.execPath}" "${join(root, 'bin/pullboard.js')}" "$@"\n`);
    chmodSync(pullboard, 0o755);
    const env = { ...process.env, PATH: [shims, process.env.PATH].filter(Boolean).join(delimiter) };
    delete env.PULLBOARD_MODEL;
    const result = spawnSync(process.execPath, [join(root, 'docs/shots/demo.mjs'), '--board-only'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `the isolated real demo board rebuild succeeds: ${result.stderr}\n${result.stdout}`);
    const state = JSON.parse(readFileSync(join(root, 'docs/demo/api/v1/boards/demo-board/state.json'), 'utf8')).state;
    const models = new Map(state.agents.map((agent) => [agent.agent_id, agent.agent_model]));
    const events = JSON.parse(readFileSync(join(root, 'docs/demo/api/v1/boards/demo-board/events.json'), 'utf8')).events;
    assert.ok(events.some((event) => event.event_kind === 'join' && event.event_by === 'coordinator'), 'the first coordinator registration is in the full event log');
    for (const event of events.filter((move) => move.event_by !== 'person')) {
      const detail = JSON.parse(event.event_detail);
      assert.ok(typeof detail.model === 'string' && detail.model.trim() && detail.model !== 'unknown', `${event.event_by} ${event.event_kind} declares its model`);
    }
    assert.deepEqual([...models].sort(), [['app-1', 'Demo builder'], ['coordinator', 'Demo coordinator'], ['review-1', 'Demo reviewer']]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

/** Keep the capture's fixture directory independent of its descriptive evidence arm. */
function captureFixturePrefix() {
  return 'rc-';
}

test("the README capture's Chrome socket path fits the Linux limit [I11,C7]", () => {
  const script = readFileSync(shots('demo.mjs'), 'utf8');
  const demoPrefix = script.match(/mkdtemp\(join\(tmpdir\(\), '([^']+)'\)\)/)?.[1];
  assert.ok(demoPrefix, 'the capture demo temporary prefix is measured from its actual creation');
  // Model the real runner's six-character mkdtemp suffix, independent of the host OS.
  const linuxRun = '/tmp/pullboard-test-run-XXXXXX';
  for (const arm of ['unchanged-default', 'foreground-control']) {
    const fixture = posix.join(linuxRun, captureFixturePrefix() + 'XXXXXX');
    const demo = posix.join(fixture, demoPrefix + 'XXXXXX');
    const paths = [posix.join(demo, 'chrome-profile', 'SingletonSocket')];
    for (const temporary of [fixture, demo]) {
      for (const browser of ['com.google.Chrome', '.org.chromium.Chromium']) {
        paths.push(posix.join(temporary, browser + '.XXXXXX', 'SingletonSocket'));
      }
    }
    for (const socket of paths) assert.ok(Buffer.byteLength(socket) < 100,
      `${arm}: Chrome socket path needs fewer than 100 bytes, got ${Buffer.byteLength(socket)}: ${socket}`);
  }
});

test('the README capture leaves no view running [I11,I13]', { timeout: 240_000 }, () => {
  const source = fileURLToPath(ROOT);
  const images = ['desktop-light.png', 'desktop-dark.png', 'phone-light.png', 'phone-dark.png', 'shouts-light.png', 'shouts-dark.png'];
  const chrome = process.env.PULLBOARD_CHROME || [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].find((candidate) => { try { return spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; } });
  assert.ok(chrome, 'the README capture requires installed headless Chrome');
  const foregroundControl = process.env.PULLBOARD_README_CAPTURE_FOREGROUND === '1';
  const arm = foregroundControl ? 'foreground-control' : 'unchanged-default';
  const evidenceDirectory = process.env.PULLBOARD_README_CAPTURE_EVIDENCE_DIR;
  if (evidenceDirectory) mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const fixture = mkdtempSync(join(tmpdir(), captureFixturePrefix()));
  try {
    const root = join(fixture, 'repo');
    mkdirSync(root);
    for (const directory of ['apps', 'packages', 'bin', 'src', 'skills', 'docs/shots', 'docs/img']) {
      cpSync(join(source, directory), join(root, directory), { recursive: true });
    }
    mkdirSync(join(root, 'test'));
    for (const file of ['package.json', 'CHANGELOG.md', 'test/chrome-fixture.js', 'test/chrome-graceful-shutdown.js', 'test/chrome-launch-args.js', 'test/fixture-child.js']) {
      cpSync(join(source, file), join(root, file));
    }
    const shims = join(fixture, 'bin');
    mkdirSync(shims);
    const pullboard = join(shims, 'pullboard');
    writeFileSync(pullboard, `#!/bin/sh\nexec "${process.execPath}" "${join(root, 'bin/pullboard.js')}" "$@"\n`);
    chmodSync(pullboard, 0o755);
    for (const image of images) rmSync(join(root, 'docs/shots', image), { force: true });
    const observationPath = join(fixture, 'capture-observation.json');
    const env = {
      ...process.env,
      PATH: [shims, process.env.PATH].filter(Boolean).join(delimiter),
      PULLBOARD_CHROME: chrome,
      PULLBOARD_README_CAPTURE_OBSERVATION_PATH: observationPath,
      TMPDIR: fixture,
      TMP: fixture,
      TEMP: fixture,
      HOME: join(fixture, 'home'),
      PULLBOARD_HOME: join(fixture, 'home'),
      PULLBOARD_MACHINE_HOME: join(fixture, 'home'),
    };
    delete env.PULLBOARD_VIEW_FOREGROUND;
    if (!foregroundControl) delete env.PULLBOARD_README_CAPTURE_FOREGROUND;
    const result = spawnSync(process.execPath, [join(root, 'docs/shots/demo.mjs'), '--screenshots-only'], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 210_000,
    });
    const observation = existsSync(observationPath) ? JSON.parse(readFileSync(observationPath, 'utf8')) : null;
    const outcome = {
      arm,
      runtime: process.version,
      platform: process.platform,
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      observation,
    };
    if (evidenceDirectory) writeFileSync(join(evidenceDirectory, `${arm}.json`), `${JSON.stringify(outcome, null, 2)}\n`, { mode: 0o600 });
    assert.equal(result.status, 0, `${arm}: the isolated README capture completes in headless Chrome: ${result.stderr}\n${result.stdout}`);
    for (const image of images) {
      assert.ok(existsSync(join(root, 'docs/shots', image)), `${arm}: ${image} was captured`);
      const bytes = readFileSync(join(root, 'docs/shots', image));
      assert.ok(bytes.length > 8, `${arm}: ${image} was captured`);
      assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${arm}: ${image} is a PNG screenshot`);
    }
    assert.ok(statSync(join(root, 'docs/demo/index.html')).size > 0, `${arm}: the demo export was rebuilt`);
    assert.ok(observation, `${arm}: the capture process identity receipt was written`);
    assert.equal(observation.viewLaunch.stdoutIsTTY, false, `${arm}: the nested view stdout is piped`);
    assert.equal(observation.viewLaunch.aiAgentPresent, false, `${arm}: the nested view has no AI_AGENT marker`);
    assert.equal(observation.viewLaunch.agentMarkersPresent, false, `${arm}: the nested view has no agent shell markers`);
    assert.notEqual(observation.viewLaunch.branch, 'unknown', `${arm}: the foreground/background branch is observed`);
    if (foregroundControl) assert.equal(observation.viewLaunch.branch, 'foreground', 'the fixture-only foreground control selects the foreground server');
    assert.equal(observation.viewAfterStop, null, `${arm}: the view PID is gone after the ordinary capture cleanup`);
    assert.deepEqual(observation.fixtureProcessesAfterStop, [], `${arm}: no process from the fixture survives capture cleanup`);
    assert.equal(observation.testCleanup.exited, true, `${arm}: the test-only exact-PID cleanup completed`);
    assert.deepEqual(observation.fixtureProcessesAfterTestCleanup, [], `${arm}: test cleanup leaves no fixture process behind`);
    assert.deepEqual(observation.teardownErrors, [], `${arm}: capture teardown completed without errors`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('the README shows the Shouts capture [I11,I13]', () => {
  linkedInSection('Pullboard View', 'shouts-light.png', ['shouts', 'answered', 'heard', 'receipt', 'code reference']);
  linkedInSection('Pullboard View', 'desktop-light.png', ['needs you', 'search', 'status bar']);
  linkedInSection('Pullboard View', 'phone-light.png', ['phone', 'active work', 'needs you', 'search']);
  const section = README.slice(README.indexOf('## Pullboard View'), README.indexOf('## Get started'));
  assert.match(section, /desktop-light\.png"[^]*shouts-light\.png"/, 'desktop and Shouts captures are together');
  const png = readFileSync(shots('shouts-light.png'));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1440, 'the Shouts capture is desktop width');
});

test('the demo assets exist and stay within their size budgets [I11,I13]', () => {
  for (const name of files) assert.ok(statSync(shots(name)).size > 0, `${name} exists`);
  for (const name of files.filter((file) => file.endsWith('.png'))) assert.ok(statSync(shots(name)).size < 300_000, `${name} is under 300 KB`);
  for (const name of ['tour.svg', 'tour-dark.svg']) assert.ok(statSync(shots(name)).size < 200_000, `${name} is under 200 KB`);
  const tour = readFileSync(shots('tour.svg'), 'utf8');
  assert.match(tour, /animation:light-step 16s linear infinite/, 'the SVG carries its own timed animation');
  assert.doesNotMatch(tour, /[\x00-\x08\x0b-\x1f]/, 'tour SVG contains no XML-invalid control characters');
});

test('the exported demo records cross-family review, a passed and answered decision, and standard doctrine [I13,A10]', () => {
  const listing = JSON.parse(readFileSync(new URL('docs/demo/api/v1/boards.json', ROOT), 'utf8'));
  assert.equal(listing.boards.length, 1);
  assert.deepEqual({ id: listing.boards[0].id, root: listing.boards[0].root, name: listing.boards[0].name },
    { id: 'demo-board', root: 'demo-board', name: 'Demo board' });
  const base = 'docs/demo/api/v1/boards/demo-board/';
  const state = JSON.parse(readFileSync(new URL(base + 'state.json', ROOT), 'utf8')).state;
  assert.equal(state.board, 'demo-board', 'the snapshot refers to its stable public board id');
  const events = JSON.parse(readFileSync(new URL(base + 'events.json', ROOT), 'utf8')).events;
  const reviewed = state.items.find((item) => item.id === 1);
  assert.equal(reviewed.status, 'verified');
  assert.deepEqual(reviewed.verdicts.map((verdict) => verdict.decision), ['REJECT', 'ACCEPT']);
  const familyOf = (id) => state.agents.find((agent) => agent.agent_id === id)?.agent_family;
  assert.equal(familyOf(reviewed.builtBy), 'codex');
  assert.equal(familyOf(reviewed.verdicts.at(-1).by), 'claude');
  assert.notEqual(familyOf(reviewed.builtBy), familyOf(reviewed.verdicts.at(-1).by));
  assert.ok(events.some((event) => event.event_kind === 'family' && JSON.parse(event.event_detail).family === 'codex'));
  assert.ok(events.some((event) => event.event_kind === 'family' && JSON.parse(event.event_detail).family === 'claude'));
  assert.ok(events.some((event) => event.event_kind === 'reject' && event.item_id === 1));
  assert.ok(events.some((event) => event.event_kind === 'accept' && event.item_id === 1));
  const joinedLanes = new Set(events.filter((event) => event.event_kind === 'join').map((event) => JSON.parse(event.event_detail).lane));
  assert.deepEqual([...joinedLanes].sort(), ['app', 'coordinator', 'review']);
  assert.ok(state.items.some((item) => item.status === 'claimed'));
  assert.ok(state.items.some((item) => item.status === 'submitted'));
  assert.deepEqual(state.spec.filter((row) => row.status === 'approved').map((row) => row.id), ['G1', 'G2']);
  assert.ok(state.practice.some((row) => row.origin === 'standard'), 'the snapshot contains the shipped standard doctrine');
  assert.ok(state.holds.some((hold) => hold.hold_lane === 'review'));
  const ask = events.findIndex((event) => event.event_kind === 'shout' && JSON.parse(event.event_detail).decision === true);
  const pass = events.findIndex((event, index) => index > ask && event.event_kind === 'pass' && event.event_by === 'coordinator');
  const answer = events.findIndex((event, index) => index > pass && event.event_kind === 'answer' && event.event_by === 'person');
  assert.ok(ask >= 0 && pass > ask && answer > pass, 'the coordinator passes the decision up and the person answers afterward');
});

test('the exported demo is synthetic and contains no machine paths or unrelated shouts [I13,A10]', () => {
  const files = ['index.html', 'view.css', 'api/v1/boards.json', 'api/v1/boards/demo-board/state.json', 'api/v1/boards/demo-board/events.json'];
  const text = files.map((file) => readFileSync(new URL('docs/demo/' + file, ROOT), 'utf8')).join('\n');
  assert.equal(text.includes(fileURLToPath(ROOT)), false, 'the export does not name this checkout');
  if (process.env.HOME) assert.equal(text.includes(process.env.HOME), false, 'the export does not name the person home');
  assert.doesNotMatch(text, /file:\/\/|\/(?:Users|private)\/|\/tmp\/pullboard-/);
  const state = JSON.parse(readFileSync(new URL('docs/demo/api/v1/boards/demo-board/state.json', ROOT), 'utf8')).state;
  assert.ok(state.agents.every((agent) => /^(coordinator|person|app-\d+|review-\d+)$/.test(agent.agent_id)), 'only generic demo roles appear as agents');
  assert.ok(state.shouts.every((shout) => [
    '#4 can continue while #3 waits for review.',
    'The review is complete. May the verified change proceed?',
    'Passed up from app-1: The review is complete. May the verified change proceed?\nCoordinator note: The review passed; ask the person before proceeding.',
    'Proceed with the verified change.',
    'Person answered #2: Proceed with the verified change.',
  ].includes(shout.shout_text)), 'the board contains only the synthetic conversation');
});

test('the demo capture starts its view on a free port [I11,I13]', () => {
  const script = readFileSync(shots('demo.mjs'), 'utf8');
  assert.match(script, /spawn\(process\.execPath, \[BIN, 'view', '--no-open', '--port', '0'\]/, 'the demo view asks the OS for an available port');
});

test('the demo rebuild script uses a temporary repo and isolated home [I11,I13]', () => {
  const script = readFileSync(shots('demo.mjs'), 'utf8');
  assert.match(script, /mkdtemp\(join\(tmpdir\(\)/);
  assert.match(readFileSync(shots('demo-env.mjs'), 'utf8'), /, HOME: home, PULLBOARD_HOME: home/);
  assert.match(script, /process\.execPath, \[BIN, 'init', '--model', 'Demo coordinator'\]/);
});

test('a Chrome evaluation exception fails the screenshot capture [I11,I13]', () => {
  assert.equal(evaluationValue({ result: { value: 'ready' } }), 'ready');
  assert.throws(() => evaluationValue({ exceptionDetails: { text: 'Uncaught SyntaxError' } }), /Chrome evaluation failed: Uncaught SyntaxError/);
});

/** Decode the real transcript kept inside the card, with XML entities decoded only once. */
function capturedTour() {
  const svg = readFileSync(shots('tour.svg'), 'utf8');
  const metadata = /<metadata id="tour-transcript">([\s\S]*?)<\/metadata>/.exec(svg);
  assert.ok(metadata, 'the card keeps its actual recorded tour for reproducible rendering');
  return JSON.parse(metadata[1].replaceAll('&apos;', "'").replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&'));
}

/** Check both committed themes as well as a fresh rendering of the real tour output, split the way the demo writes it. */
function cards() {
  const rendered = themeVariants(renderTour(capturedTour()));
  return [readFileSync(shots('tour.svg'), 'utf8'), readFileSync(shots('tour-dark.svg'), 'utf8'), rendered.light, rendered.dark];
}

test('the compact tour card holds eight ordered, single-line steps and both verdict tags [I13]', () => {
  for (const svg of cards()) {
    const [, width, height] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    assert.ok(Number(width) <= 640 && Number(height) <= 420, 'the tour is a compact card');
    const rows = [...svg.matchAll(/<g class="tour-step" data-step="(\d+)" data-actor="([^"]+)">([\s\S]*?)<\/g>/g)];
    assert.deepEqual(rows.map(([, number]) => Number(number)), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(rows.map(([, , actor]) => actor), ['you', 'coordinator', 'builder', 'verifier', 'builder', 'builder', 'verifier', 'coordinator']);
    for (const row of rows) {
      assert.equal([...row[3].matchAll(/class="description"/g)].length, 1, 'each step has one descriptive text line');
    }
    assert.match(rows[3][3], /class="verdict reject"[\s\S]*>REJECT<\/text>/);
    assert.match(rows[6][3], /class="verdict accept"[\s\S]*>ACCEPT<\/text>/);
    assert.match(svg, /BEHAVIOR_MISMATCH/);
    assert.match(svg, /CRITERION_MET/);
    assert.doesNotMatch(svg, /<script\b/);
  }
});

test('the card lights steps in turn and holds still for reduced motion [I13]', () => {
  for (const svg of cards()) {
    assert.match(svg, /animation:light-step 16s linear infinite/);
    assert.deepEqual([...svg.matchAll(/animation-delay:(\d+)s/g)].map(([, delay]) => Number(delay)), [0, 2, 4, 6, 8, 10, 12, 14]);
    assert.match(svg, /@media\(prefers-reduced-motion:reduce\)\{\.step-glow\{animation:none;fill:transparent\}\}/);
  }
});

test('the card carries distinct actor and verdict colours for light and dark readers [I13]', () => {
  const [light, dark, renderedLight, renderedDark] = cards();
  assert.equal(light, renderedLight, 'tour.svg is the light card of the recorded tour');
  assert.equal(dark, renderedDark, 'tour-dark.svg is the dark card of the recorded tour');
  for (const color of ['#101714', '#315f8f', '#6547bc', '#087546']) assert.ok(light.includes(color), color);
  for (const color of ['#e9eeeb', '#80bfff', '#c1aeff', '#61e6b1']) assert.ok(dark.includes(color) && !light.includes(color), color);
  for (const svg of [light, dark]) {
    assert.doesNotMatch(svg, /prefers-color-scheme/, 'each card holds one theme, and its picture picks the reader\'s');
    for (const [actor, color] of [['you', 'ink'], ['coordinator', 'blue'], ['builder', 'violet'], ['verifier', 'green']]) {
      assert.ok(svg.includes(`.${actor}{fill:var(--${color})}`), `${actor} has its own colour`);
    }
    assert.match(svg, /\.reject text\{fill:var\(--red\)\}/);
    assert.match(svg, /\.accept text\{fill:var\(--green\)\}/);
  }
});

test('the card changes when the real tour facts change and escapes its captured text [I13]', () => {
  const captured = capturedTour();
  const changed = captured.map(({ text, at }) => ({ text: text.replaceAll('greet', 'welcome').replaceAll('Hello, world!', 'Hello, earth!').replaceAll('Hello, !', 'Hello, <guest>!').replaceAll('not from memory', 'not from notes'), at }));
  const svg = renderTour(changed);
  assert.match(svg, /class="description"[^>]*>approve one spec row: welcome a blank name as &quot;earth&quot;<\/text>/);
  assert.match(svg, /class="description"[^>]*>claims it, builds welcome\(\), submits with tests green<\/text>/);
  assert.match(svg, /class="description"[^>]*>tries a blank name, gets &quot;Hello, &lt;guest&gt;!&quot;<\/text>/);
  assert.match(svg, /class="description"[^>]*>reads why from the board, not from notes\.<\/text>/);
  assert.doesNotMatch(svg, /<guest>/);
  assert.throws(() => renderTour(captured.filter(({ text }) => !text.startsWith('8  '))), /eight numbered tour steps/);
  assert.throws(() => renderTour(captured.filter(({ text }) => !text.includes('# fail 1'))), /deliberately failing test/);
  assert.match(readFileSync(shots('demo.mjs'), 'utf8'), /NO_COLOR: '1'/);
});


const videoManifest = JSON.parse(readFileSync(shots('video.json'), 'utf8'));

test('the product video follows its five-line story and keeps captions publishable [I14]', () => {
  assert.deepEqual(videoManifest.scenes.map((scene) => scene.id), ['problem', 'constraints', 'holds', 'proof', 'tagline']);
  assert.equal(videoManifest.scenes.reduce((sum, scene) => sum + scene.seconds, 0), 90);
  for (const scene of videoManifest.scenes) {
    assert.equal(scene.line, scene.caption, `${scene.id} burns in the narrated line`);
    assert.ok(scene.caption.length <= 48, `${scene.id} caption fits one short line`);
    assert.equal(scene.beats.length, 3, `${scene.id} contains three diagram stages`);
  }
  assert.deepEqual(videoManifest.scenes.find((scene) => scene.id === 'proof').stats, ['submissions', 'rejections', 'merged']);
  const manifestText = readFileSync(shots('video.json'), 'utf8');
  assert.doesNotMatch(manifestText, /(?:\/Users\/|\/private\/|file:\/\/|shout|coreyolson)/iu);
  const renderer = readFileSync(shots('video.mjs'), 'utf8');
  assert.match(renderer, /'stats', '--json'/u, 'the proof figures come from pullboard stats');
  assert.match(renderer, /document\.stats/u, 'the renderer reads the CLI statistics document');
  assert.match(renderer, /product-1920x1080\.mp4/u);
  assert.match(renderer, /product-1080x1350\.mp4/u);
  assert.match(renderer, /sizeLimitBytes/u, 'the script enforces the file-size budget');
});

test('narration VTT cues set scene timing and refuse drift or overlap [I14]', () => {
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:14.000
${videoManifest.scenes[0].line}

00:00:14.000 --> 00:00:31.000
${videoManifest.scenes[1].line}

00:00:31.000 --> 00:00:58.000
${videoManifest.scenes[2].line}

00:00:58.000 --> 00:01:18.000
${videoManifest.scenes[3].line}

00:01:18.000 --> 00:01:30.000
${videoManifest.scenes[4].line}
`;
  const cues = parseVtt(vtt, videoManifest.scenes);
  assert.deepEqual(narrationDurations(videoManifest.scenes, cues, 90), [14, 17, 27, 20, 12]);
  assert.deepEqual(narrationDurations(videoManifest.scenes, cues, 90.25), [14, 17, 27, 20, 12.25]);
  assert.throws(() => parseVtt(vtt.replace('00:00:14.000 --> 00:00:31.000', '00:00:13.000 --> 00:00:31.000'), videoManifest.scenes), /never overlap/u);
  assert.throws(() => parseVtt(vtt.replace(`${videoManifest.scenes[2].line}`, 'a different narration line'), videoManifest.scenes), /must match/u);
  assert.throws(() => parseVtt(vtt.slice(0, vtt.indexOf('\n\n00:01:18.000')), videoManifest.scenes), /has 4 cues/u);
  const second = `00:00:14.000 --> 00:00:31.000\n${videoManifest.scenes[1].line}`;
  const third = `00:00:31.000 --> 00:00:58.000\n${videoManifest.scenes[2].line}`;
  assert.throws(() => parseVtt(vtt.replace(`${second}\n\n${third}`, `${third}\n\n${second}`), videoManifest.scenes), /increase in time/u);
  const gappedVtt = vtt.replace('00:00:00.000 --> 00:00:14.000', '00:00:00.000 --> 00:00:13.000')
    .replace('00:00:14.000 --> 00:00:31.000', '00:00:14.000 --> 00:00:31.000')
    .replace('00:00:31.000 --> 00:00:58.000', '00:00:33.000 --> 00:00:58.000')
    .replace('00:00:58.000 --> 00:01:18.000', '00:00:59.000 --> 00:01:18.000')
    .replace('00:01:18.000 --> 00:01:30.000', '00:01:20.000 --> 00:01:30.000');
  assert.deepEqual(narrationDurations(videoManifest.scenes, parseVtt(gappedVtt, videoManifest.scenes), 90), [14, 19, 26, 21, 10]);
  assert.throws(() => narrationDurations(videoManifest.scenes, cues, 91), /91\.000s.*90\.000s/u);
});
