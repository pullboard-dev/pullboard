#!/usr/bin/env node
/** Render the five-line product explainer as two animated, captioned cuts [I14]. */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser } from './capture-browser.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SHOTS = join(ROOT, 'docs', 'shots');
const OUT = join(SHOTS, 'out');
const MANIFEST = join(SHOTS, 'video.json');
const CHROME_PATHS = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const SIZES = [{ name: 'landscape', width: 1920, height: 1080 }, { name: 'portrait', width: 1080, height: 1350 }];

/** Run a local command and report its captured diagnostic when it fails. */
function command(file, args, cwd = ROOT, env = process.env) {
  const result = spawnSync(file, args, { cwd, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${file} ${args.join(' ')} failed: ${(result.stderr || result.stdout || result.error?.message || 'unknown error').trim()}`);
  return result.stdout.trim();
}

/** Format a VTT clock as seconds without accepting invalid minutes or seconds. */
function vttTime(value) {
  const match = /^(\d{2,}):(\d{2}):(\d{2})\.(\d{3})$/u.exec(value);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) throw new Error(`Invalid WebVTT timestamp: ${value}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

/** Read one ordered narration cue per scene, rejecting missing, reversed or overlapping timing. */
export function parseVtt(source, scenes) {
  const lines = source.replace(/^\uFEFF/u, '').replaceAll('\r', '').split('\n');
  if (!/^WEBVTT(?:\s|$)/u.test(lines[0] ?? '')) throw new Error('Narration timing must be a WebVTT file beginning with WEBVTT.');
  const cues = [];
  for (let index = 1; index < lines.length;) {
    while (index < lines.length && !lines[index].trim()) index += 1;
    if (index >= lines.length) break;
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/u.test(lines[index])) {
      while (index < lines.length && lines[index].trim()) index += 1;
      continue;
    }
    if (!lines[index].includes('-->')) index += 1;
    const timing = /^(\d{2,}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2,}:\d{2}:\d{2}\.\d{3})(?:\s+.*)?$/u.exec(lines[index] ?? '');
    if (!timing) throw new Error('Each narration cue needs a valid WebVTT start and end timestamp.');
    const text = [];
    index += 1;
    while (index < lines.length && lines[index].trim()) text.push(lines[index++].trim());
    const start = vttTime(timing[1]);
    const end = vttTime(timing[2]);
    const previous = cues.at(-1);
    if (!(end > start) || (previous && (start <= previous.start || start < previous.end))) {
      throw new Error('Narration cues must increase in time and never overlap.');
    }
    if (!text.join(' ').trim()) throw new Error('Narration cues cannot be empty.');
    cues.push({ start, end, text: text.join(' ') });
  }
  if (!Array.isArray(scenes) || cues.length !== scenes.length) {
    throw new Error(`Narration VTT has ${cues.length} cues; video.json has ${scenes?.length ?? 0} scene lines.`);
  }
  cues.forEach((cue, index) => {
    if (cue.text !== scenes[index].line) throw new Error(`Narration cue ${index + 1} must match the ${scenes[index].id} scene line in video.json.`);
  });
  return cues;
}

/** Place each scene on its narration cue, holding its diagram through any pause before the next line. */
export function narrationDurations(scenes, cues, audioSeconds) {
  if (Math.abs(audioSeconds - cues.at(-1).end) > 0.5) {
    throw new Error(`Narration audio is ${audioSeconds.toFixed(3)}s, but its last VTT cue ends at ${cues.at(-1).end.toFixed(3)}s (difference exceeds 0.5s).`);
  }
  return scenes.map((_, index) => {
    const start = index === 0 ? 0 : cues[index].start;
    const end = index + 1 < cues.length ? cues[index + 1].start : audioSeconds;
    if (!(end > start)) throw new Error(`Narration cue ${index + 1} leaves no time for its scene.`);
    return end - start;
  });
}

/** Read aggregates through this repository's canonical checkout, never agent IDs or shout text. */
function pullboardStats() {
  const commonDir = command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const mainRoot = dirname(commonDir);
  const bin = join(mainRoot, 'bin', 'pullboard.js');
  const document = JSON.parse(command(process.execPath, [bin, 'stats', '--json'], mainRoot));
  if (document.version !== 1 || !document.stats || !Number.isSafeInteger(document.stats.submissions)) {
    throw new Error('pullboard stats returned an unexpected versioned document.');
  }
  const { submissions, rejections, merged } = document.stats;
  return { submissions, rejections, merged };
}

/** Escape text before placing it inside the generated SVG document. */
function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

/** Draw one legible line of SVG text. */
function label(x, y, value, size = 34, color = '#26342f', weight = 500, anchor = 'middle') {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${color}" font-family="Arial, sans-serif" font-size="${size}" font-weight="${weight}">${xml(value)}</text>`;
}

/** Draw a rounded diagram card with a restrained accent and optional detail. */
function card(x, y, width, height, title, detail = '', accent = '#76a996', selected = false) {
  const fill = selected ? '#e2f2e9' : '#ffffff';
  return `<g><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="26" fill="${fill}" stroke="${accent}" stroke-width="4"/><path d="M${x + 24} ${y + 22}H${x + width - 24}" stroke="${accent}" stroke-width="5" stroke-linecap="round"/>${label(x + width / 2, y + height * 0.53, title, Math.min(34, width / 12), '#26342f', 700)}${detail ? label(x + width / 2, y + height * 0.76, detail, Math.min(25, width / 17), '#62736a') : ''}</g>`;
}

/** Draw a directional connector behind its diagram nodes. */
function arrow(x1, y1, x2, y2, color = '#98aaa0') {
  return `<path d="M${x1} ${y1} L${x2} ${y2}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" marker-end="url(#arrow)"/>`;
}

/** Build the responsive, staged diagram for one script line and its live proof numbers. */
function diagram(scene, beat, size, stats) {
  const { width, height } = size;
  const portrait = height > width;
  const step = beat;
  const pieces = [];
  /** Append SVG elements to the current diagram, keeping each scene branch readable. */
  const add = (...values) => pieces.push(...values);
  if (scene.id === 'problem') {
    if (!portrait) {
      add(card(150, 340, 420, 250, 'Build this', 'a short request', '#9a8de0', step === 0));
      if (step >= 1) add(arrow(570, 465, 870, 300), arrow(570, 465, 870, 465), arrow(570, 465, 870, 630));
      if (step >= 1) add(card(900, 220, 500, 155, 'Skip the edge case', '', '#e58c77', step === 1), card(900, 390, 500, 155, 'Assume the happy path', '', '#d7a45a', step === 1), card(900, 560, 500, 155, 'Invent the missing rule', '', '#9a8de0', step === 2));
      if (step >= 2) add(label(1610, 480, 'Three plausible answers.', 34, '#8b4b40', 700));
    } else {
      add(card(170, 260, 740, 175, 'Build this', 'a short request', '#9a8de0', step === 0));
      if (step >= 1) add(arrow(540, 435, 540, 545));
      if (step >= 1) add(card(170, 565, 740, 150, 'Skip the edge case', '', '#e58c77', step === 1), card(170, 745, 740, 150, 'Assume the happy path', '', '#d7a45a', step === 1));
      if (step >= 2) add(card(170, 925, 740, 150, 'Invent the missing rule', '', '#9a8de0', true));
    }
  } else if (scene.id === 'constraints') {
    if (!portrait) {
      add(card(100, 360, 510, 250, 'Approved row', 'blank name → “world”', '#7697cf', step >= 1));
      if (step >= 1) add(arrow(610, 485, 810, 485), card(825, 300, 340, 370, 'Frozen bar', 'locks at claim', '#927ed6', step === 1));
      if (step >= 2) add(arrow(1165, 485, 1360, 485), card(1380, 360, 430, 250, 'Hello, world!', 'the blank is filled', '#5ca886', true));
    } else {
      add(card(170, 255, 740, 195, 'Approved row', 'blank name → “world”', '#7697cf', step >= 1));
      if (step >= 1) add(arrow(540, 450, 540, 560), card(170, 580, 740, 175, 'Frozen bar', 'locks at claim', '#927ed6', step === 1));
      if (step >= 2) add(arrow(540, 755, 540, 855), card(170, 875, 740, 195, 'Hello, world!', 'the blank is filled', '#5ca886', true));
    }
  } else if (scene.id === 'holds') {
    const nodes = [['SPEC.md', 'approved rows', '#7397c9'], ['task', 'cites its rows', '#987dd1'], ['claim', 'freezes the bar', '#db9b57'], ['verify', 'another agent checks', '#58a884']];
    if (!portrait) {
      const xs = [100, 545, 990, 1435];
      for (let index = 0; index < nodes.length; index += 1) {
        const [title, detail, color] = nodes[index];
        if (index > 0 && step >= index - 1) add(arrow(xs[index] - 55, 480, xs[index], 480));
        if (step >= Math.max(0, index - 1)) add(card(xs[index], 370, 360, 220, title, detail, color, step === index));
      }
      if (step >= 2) add(label(960, 690, 'A separate worktree keeps each lane apart.', 30, '#62736a'));
    } else {
      const ys = [240, 435, 630, 825];
      for (let index = 0; index < nodes.length; index += 1) {
        const [title, detail, color] = nodes[index];
        if (index > 0 && step >= index - 1) add(arrow(540, ys[index] - 22, 540, ys[index]));
        if (step >= Math.max(0, index - 1)) add(card(170, ys[index], 740, 150, title, detail, color, step === index));
      }
      if (step >= 2) add(label(540, 1030, 'The proof stays with the item.', 28, '#62736a'));
    }
  } else if (scene.id === 'proof') {
    const values = [stats.submissions, stats.rejections, stats.merged];
    const names = ['submissions', 'sent back', 'merged'];
    if (!portrait) {
      const xs = [180, 735, 1290];
      for (let index = 0; index < values.length; index += 1) add(card(xs[index], 265, 450, 190, String(values[index]), names[index], ['#7697cf', '#e58c77', '#5ca886'][index], step === index));
      if (step >= 0) add(arrow(410, 500, 690, 625));
      add(card(710, 560, 500, 150, 'REJECT', 'reason stays attached', '#e58c77', step === 0));
      if (step >= 1) add(arrow(960, 710, 960, 760), card(710, 770, 500, 130, 'REWORK', 'the bar still holds', '#987dd1', step === 1));
      if (step >= 2) add(arrow(1210, 625, 1455, 500), card(1460, 560, 350, 150, 'ACCEPT', 'checked by another', '#5ca886', true));
    } else {
      for (let index = 0; index < values.length; index += 1) add(card(170, 215 + index * 170, 740, 145, String(values[index]), names[index], ['#7697cf', '#e58c77', '#5ca886'][index], step === index));
      add(card(170, 765, 350, 145, 'REJECT', 'reason stays', '#e58c77', step === 0));
      if (step >= 1) add(arrow(520, 835, 580, 835), card(580, 765, 330, 145, 'REWORK', 'bar holds', '#987dd1', step === 1));
      if (step >= 2) add(arrow(540, 910, 540, 950), card(170, 960, 740, 125, 'ACCEPT', 'another agent checked', '#5ca886', true));
    }
  } else {
    if (!portrait) {
      add(card(220, 340, 580, 300, 'Your words', 'become an approved row', '#7397c9', step === 0));
      if (step >= 1) add(arrow(800, 490, 1060, 490), card(1090, 340, 600, 300, 'SPEC.md', 'kept in your repo', '#5ca886', step === 1));
      if (step >= 2) add(label(960, 735, 'Agents fill the blanks inside your constraints.', 34, '#62736a', 600));
    } else {
      add(card(170, 320, 740, 235, 'Your words', 'become an approved row', '#7397c9', step === 0));
      if (step >= 1) add(arrow(540, 555, 540, 665), card(170, 690, 740, 235, 'SPEC.md', 'kept in your repo', '#5ca886', step === 1));
      if (step >= 2) add(label(540, 1010, 'Agents fill the blanks', 33, '#62736a', 600));
    }
  }
  const titleY = portrait ? 135 : 130;
  const captionY = portrait ? 1200 : 930;
  const captionWidth = portrait ? width - 100 : width - 180;
  const captionX = (width - captionWidth) / 2;
  const captionHeight = portrait ? 105 : 92;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><marker id="arrow" markerWidth="12" markerHeight="12" refX="9" refY="6" orient="auto"><path d="M1 1L10 6L1 11" fill="none" stroke="#98aaa0" stroke-width="2"/></marker></defs>
<rect width="100%" height="100%" fill="#f5f3ed"/><circle cx="${width * .82}" cy="${height * .18}" r="${portrait ? 230 : 330}" fill="#e8f1eb"/><circle cx="${width * .11}" cy="${height * .79}" r="${portrait ? 170 : 250}" fill="#eee9f7"/>
${label(width / 2, titleY, 'PULLBOARD  ·  CONSTRAINTS THAT LAST', portrait ? 23 : 25, '#60746a', 700)}
${pieces.join('\n')}
<rect x="${captionX}" y="${captionY}" width="${captionWidth}" height="${captionHeight}" rx="28" fill="#182721"/><text x="${width / 2}" y="${captionY + captionHeight * .64}" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="${portrait ? 38 : 42}" font-weight="650">${xml(scene.caption)}</text>
</svg>`;
}

/** Find a working Chrome binary for the local deterministic SVG rasterizer. */
function chromeBinary() {
  const found = CHROME_PATHS.find((path) => spawnSync(path, ['--version'], { stdio: 'ignore' }).status === 0);
  if (!found) throw new Error('Google Chrome is required to rasterize the diagram frames.');
  return found;
}

/** Capture every staged SVG at the target video dimensions using an isolated Chrome profile. */
async function renderFrames(temp, manifest, stats) {
  const chrome = chromeBinary();
  const profile = join(temp, 'chrome-profile');
  const view = await browser(chrome, profile, 'about:blank');
  const frames = new Map();
  try {
    for (const size of SIZES) {
      await view.viewport(size.width, size.height);
      for (const scene of manifest.scenes) {
        for (let beat = 0; beat < scene.beats.length; beat += 1) {
          const svg = diagram(scene, beat, size, stats);
          await view.evaluate(`(()=>{document.documentElement.style.margin='0';document.documentElement.style.width='100%';document.documentElement.style.height='100%';document.body.style.margin='0';document.body.style.width='100%';document.body.style.height='100%';document.body.style.overflow='hidden';document.body.innerHTML=${JSON.stringify(svg)};return true})()`);
          await view.waitFor('!!document.querySelector("body > svg")', `the ${scene.id} diagram frame`);
          const path = join(temp, `${size.name}-${scene.id}-${beat}.png`);
          await view.screenshot(path);
          frames.set(`${size.name}:${scene.id}:${beat}`, path);
        }
      }
    }
  } finally { await view.close(); }
  return frames;
}

/** Quote a path for ffmpeg's concat demuxer without exposing a shell interpolation. */
function concatPath(path) {
  return path.replaceAll("'", "'\\''");
}

/** Encode the staged frames into a small, constant-frame-rate H.264 cut. */
function encodeVideo(frames, scenes, durations, size, out, temp, fps, audio) {
  const entries = [];
  scenes.forEach((scene, index) => {
    const each = durations[index] / scene.beats.length;
    scene.beats.forEach((_, beat) => entries.push({ file: frames.get(`${size.name}:${scene.id}:${beat}`), duration: each }));
  });
  const list = join(temp, `${size.name}.ffconcat`);
  const last = entries.at(-1).file;
  writeFileSync(list, entries.map(({ file, duration }) => `file '${concatPath(file)}'\nduration ${duration.toFixed(6)}`).join('\n') + `\nfile '${concatPath(last)}'\n`);
  command('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', `fps=${fps},zoompan=z='1+0.035*mod(on\,${fps * 6})/${fps * 6}':d=1:s=${size.width}x${size.height}:fps=${fps}`,
    '-t', durations.reduce((sum, value) => sum + value, 0).toFixed(3), '-an', '-c:v', 'libx264', '-preset', 'medium', '-threads', '2', '-crf', '27', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], temp);
  if (audio) {
    const silent = join(temp, size.name + '.silent.mp4');
    command('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', out, '-map', '0:v:0', '-c:v', 'copy', silent], temp);
    command('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', silent, '-i', audio,
      '-map', '0:v:0', '-map', '1:a:0', '-t', durations.reduce((sum, value) => sum + value, 0).toFixed(3), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out], temp);
  }
}

/** Run the complete reproducible video build, with optional audio and matching WebVTT cues. */
export async function buildVideo({ narration = null, vtt = null } = {}) {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  if (!Array.isArray(manifest.scenes) || manifest.scenes.length !== 5) throw new Error('video.json must contain the five product story scenes in order.');
  if (manifest.scenes.reduce((sum, scene) => sum + scene.seconds, 0) !== 90) throw new Error('Default scene pacing must total 90 seconds.');
  for (const scene of manifest.scenes) {
    if (scene.caption.length > 48) throw new Error(`The ${scene.id} caption exceeds 48 characters.`);
  }
  if (Boolean(narration) !== Boolean(vtt)) throw new Error('Supply both --narration <audio-file> and --vtt <timing-file>, or neither.');
  const durations = narration
    ? narrationDurations(manifest.scenes, parseVtt(await readFile(vtt, 'utf8'), manifest.scenes), Number(command('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', narration])))
    : manifest.scenes.map((scene) => scene.seconds);
  const stats = pullboardStats();
  const temp = await mkdtemp(join(tmpdir(), 'pullboard-video-'));
  try {
    const frames = await renderFrames(temp, manifest, stats);
    await mkdir(OUT, { recursive: true });
    for (const size of SIZES) {
      const file = join(OUT, size.name === 'landscape' ? 'product-1920x1080.mp4' : 'product-1080x1350.mp4');
      encodeVideo(frames, manifest.scenes, durations, size, file, temp, manifest.fps, narration);
      const bytes = (await readFile(file)).length;
      if (bytes >= manifest.sizeLimitBytes) throw new Error(`${file} is ${bytes} bytes; the limit is ${manifest.sizeLimitBytes}.`);
      process.stdout.write(`${file}: ${size.width}×${size.height}, ${durations.reduce((sum, value) => sum + value, 0).toFixed(1)}s, ${(bytes / 1_000_000).toFixed(2)} MB\n`);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
}

/** Parse the two supported narration arguments without accepting undocumented switches. */
function parseOptions(args) {
  const options = { narration: null, vtt: null };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!['--narration', '--vtt'].includes(name) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error('Usage: node docs/shots/video.mjs [--narration <audio-file> --vtt <timings.vtt>]');
    }
    options[name === '--narration' ? 'narration' : 'vtt'] = resolve(args[++index]);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await buildVideo(parseOptions(process.argv.slice(2))); }
  catch (error) { process.stderr.write(`pullboard video: ${error.message}\n`); process.exitCode = 1; }
}
