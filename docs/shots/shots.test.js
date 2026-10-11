/**
 * The README's screenshots and timed tour recording (I11, I13) are reproducible demo artifacts,
 * and fit the size budgets so they stay useful in the README and the site.
 */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluationValue } from './devtools-evaluation.mjs';
import { renderTour } from './tour-renderer.mjs';
import { narrationDurations, parseVtt } from './video.mjs';

const ROOT = new URL('../../', import.meta.url);
const README = readFileSync(new URL('README.md', ROOT), 'utf8');
const files = ['desktop.png', 'phone.png', 'shouts.png', 'tour.svg'];
const shots = (name) => new URL(`docs/shots/${name}`, ROOT);

/** Assert that an image is embedded in a named README section with useful alt text. */
function linkedInSection(section, file, phrases) {
  const start = README.indexOf(`## ${section}`);
  assert.notEqual(start, -1, `README has the ${section} section`);
  const next = README.indexOf('\n## ', start + 1);
  const body = README.slice(start, next < 0 ? undefined : next);
  const match = new RegExp(`!\\[([^\\]]+)\\]\\(docs/shots/${file.replace('.', '\\.')}\\)`).exec(body);
  assert.ok(match, `${file} is embedded in ${section}`);
  for (const phrase of phrases) assert.ok(match[1].toLowerCase().includes(phrase), `${file} alt text says ${phrase}`);
}

test('the README links the desktop board and timed tour with descriptive alt text [I11,I13]', () => {
  linkedInSection('Pullboard View', 'desktop.png', ['open', 'claimed', 'submitted', 'accepted']);
  linkedInSection('Installation', 'tour.svg', ['submitted', 'rejected', 'fixed', 'accepted']);
});

test('the demo board stages a Shouts conversation [I11,I13]', () => {
  const { state } = JSON.parse(readFileSync(new URL('docs/demo/api/v1/boards/demo-board/state.json', ROOT), 'utf8'));
  const agents = state.agents.filter((agent) => agent.agent_id !== 'person');
  assert.equal(agents.length, 3, 'the demo has a coordinator, builder and reviewer');
  const senders = new Set(state.shouts.map((shout) => shout.shout_from).filter((id) => id !== 'person'));
  assert.deepEqual([...senders].sort(), ['app-1', 'coordinator', 'review-1']);
  const decision = state.shouts.find((shout) => shout.shout_decision && shout.shout_to === 'person');
  assert.ok(decision, 'the coordinator asks the person');
  const answer = state.shouts.find((shout) => shout.shout_from === 'person' && shout.shout_answers === decision.shout_id);
  assert.ok(answer, 'the person answers that decision');
  assert.ok(agents.some((agent) => ['all', agent.agent_id, agent.agent_lane].includes(answer.shout_to)
    && agent.agent_last_shout_id >= answer.shout_id), 'an addressed agent has Heard the person');
  const receipt = state.shouts.find((shout) => shout.shout_evidence_kind === 'receipt');
  assert.ok(receipt, 'the conversation includes an evidence receipt');
  assert.equal(receipt.shout_evidence_item, 1);
  assert.equal(receipt.shout_evidence_outcome, 'edge passes');
  assert.equal(receipt.shout_evidence_commit, state.items.find((item) => item.id === 1).commit);
  assert.ok(state.shouts.some((shout) => shout.shout_text.includes(`src/demo.js:1@${receipt.shout_evidence_commit}`)), 'the code reference points at the reviewed fix');
});

test('the README shows the Shouts capture [I11,I13]', () => {
  linkedInSection('Pullboard View', 'shouts.png', ['shouts', 'answered', 'heard', 'receipt', 'code reference']);
  linkedInSection('Pullboard View', 'desktop.png', ['needs you', 'search', 'status bar']);
  linkedInSection('Pullboard View', 'phone.png', ['phone', 'dark', 'active work', 'needs you', 'search']);
  const section = README.slice(README.indexOf('## Pullboard View'), README.indexOf('## Get started'));
  assert.match(section, /desktop\.png\)[^]*shouts\.png\)/, 'desktop and Shouts captures are together');
  const png = readFileSync(shots('shouts.png'));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1440, 'the Shouts capture is desktop width');
});

test('the demo assets exist and stay within their size budgets [I11,I13]', () => {
  for (const name of files) assert.ok(statSync(shots(name)).size > 0, `${name} exists`);
  assert.ok(statSync(shots('desktop.png')).size < 300_000, 'desktop PNG is under 300 KB');
  assert.ok(statSync(shots('phone.png')).size < 300_000, 'phone PNG is under 300 KB');
  assert.ok(statSync(shots('shouts.png')).size < 300_000, 'Shouts PNG is under 300 KB');
  assert.ok(statSync(shots('tour.svg')).size < 200_000, 'tour SVG is under 200 KB');
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
    'Person answered #3: Proceed with the verified change.',
  ].includes(shout.shout_text) || /^#1 passes the edge that failed before\. The fix is in src\/demo\.js:1@[a-f0-9]{40}\.$/.test(shout.shout_text)), 'the board contains only the synthetic conversation');
});

test('the demo rebuild script uses a temporary repo and isolated home [I11,I13]', () => {
  const script = readFileSync(shots('demo.mjs'), 'utf8');
  assert.match(script, /mkdtemp\(join\(tmpdir\(\)/);
  assert.match(readFileSync(shots('demo-env.mjs'), 'utf8'), /, HOME: home, PULLBOARD_HOME: home/);
  assert.match(script, /process\.execPath, \[BIN, 'init'\]/);
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

/** Check the committed image as well as a fresh rendering of its real tour output. */
function cards() {
  return [readFileSync(shots('tour.svg'), 'utf8'), renderTour(capturedTour())];
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
  for (const svg of cards()) {
    assert.match(svg, /@media\(prefers-color-scheme:dark\)/);
    for (const color of ['#101714', '#315f8f', '#6547bc', '#087546', '#e9eeeb', '#80bfff', '#c1aeff', '#61e6b1']) assert.ok(svg.includes(color), color);
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
