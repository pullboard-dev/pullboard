/** Read durations already printed by a caller's test runner, without changing its command [C7,V10]. */
import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const MAX_LINE = 64 * 1024;

/** Name the executable or familiar test runner without persisting the command's arguments. */
export function timingRunner(command) {
  const known = /\b(go\s+test|cargo\s+test|dotnet\s+test|npm\s+test|pytest|node|mvn|gradle|rspec)\b/u.exec(command);
  return known?.[1] ?? (command.trim().split(/\s+/u)[0]?.replace(/^.*[/\\]/u, '').replaceAll(/["']/gu, '').slice(0, 80) || 'shell');
}

/** Decode only XML's built-in and numeric entities; never resolve external entities. */
function xmlText(value) {
  return value.replace(/&(?:#(x[0-9a-f]+|[0-9]+)|(amp|lt|gt|quot|apos));/giu, (whole, number, named) => {
    if (number) {
      const point = Number.parseInt(number.startsWith('x') ? number.slice(1) : number, number.startsWith('x') ? 16 : 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : whole;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named.toLowerCase()];
  });
}

/** Read quoted JUnit attributes without executing XML declarations or markup. */
function attributes(source) {
  return Object.fromEntries([...source.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)]
    .map(match => [match[1], xmlText(match[2] ?? match[3])]));
}

/** Accept only finite, nonnegative printed measurements. */
function duration(value, scale = 1) {
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value)) return null;
  const measured = Number(value) * scale;
  return Number.isFinite(measured) && measured >= 0 ? measured : null;
}

/** Parse existing TAP diagnostics and JUnit tags, retaining no inferred file durations.
 * @param {string|Iterable<string>} output - Complete output, or bounded lines from a private log.
 * @param {string} runner - Value-free runner identity for unsupported output.
 */
export function timingFromOutput(output, runner = 'shell') {
  const files = [];
  const tests = [];
  const formats = new Set();
  const suites = [];
  let tap = null;
  let junit = null;
  let xmlPending = '';
  /** Finish a TAP diagnostic block only when it actually carries a duration. */
  const finishTap = () => {
    if (tap?.durationMs !== null && tap?.durationMs !== undefined && tap.type !== 'suite') {
      // Node's crashed-file wrapper has an exitCode and a matching source location, not a case.
      if (tap.exitCode && (tap.file === tap.name || tap.file?.endsWith('/' + tap.name))) files.push({ path: tap.name, durationMs: tap.durationMs });
      else tests.push({ file: tap.file, name: tap.name, durationMs: tap.durationMs, passed: tap.passed });
    }
    tap = null;
  };
  /** Finish a JUnit testcase, including a self-closing success or a nested failure. */
  const finishJunit = () => {
    if (junit && junit.durationMs !== null) tests.push(junit);
    junit = null;
  };
  for (const raw of typeof output === 'string' ? output.split(/\r?\n/u) : output) {
    if (Buffer.byteLength(raw, 'utf8') > MAX_LINE) continue;
    const line = raw.trim();
    if (/^TAP version \d+$/u.test(line)) formats.add('tap');
    const result = /^(not ok|ok)\s+\d+(?:\s*-\s*(.*?))?(?:\s+#\s*(?:SKIP|TODO)\b.*)?$/iu.exec(line);
    if (result) {
      finishTap();
      formats.add('tap');
      tap = { name: result[2] ?? '', file: null, durationMs: null, type: null, passed: result[1] === 'ok', exitCode: false, indent: raw.length - raw.trimStart().length };
    } else if (tap) {
      const field = /^(duration_ms|type|location|exitCode):\s*(.*)$/u.exec(line);
      if (field && raw.length - raw.trimStart().length === tap.indent + 2) {
        const value = field[2].replace(/^(['"])(.*)\1$/u, '$2');
        if (field[1] === 'duration_ms') tap.durationMs = duration(value);
        if (field[1] === 'type') tap.type = value;
        if (field[1] === 'location') tap.file = value.replace(/:\d+:\d+$/u, '');
        if (field[1] === 'exitCode') tap.exitCode = true;
      }
      if (line === '...') finishTap();
    }
    // Tags can span lines, but keep their pending text bounded like the diagnostic scanner.
    const xml = xmlPending ? xmlPending + '\n' + raw : raw;
    const tags = [...xml.matchAll(/<(\/?)([\w:.-]+)\b([^<>]*?)(\/?)>/gu)];
    for (const tag of tags) {
      const name = tag[2].split(':').at(-1);
      const closing = tag[1] === '/';
      const selfClosing = tag[4] === '/';
      const attrs = attributes(tag[3]);
      if (name === 'testsuites' || name === 'testsuite') formats.add('junit');
      if (name === 'testsuite' && !closing) {
        const suite = { file: attrs.file ?? null, durationMs: duration(attrs.time, 1000) };
        if (suite.file && suite.durationMs !== null) files.push({ path: suite.file, durationMs: suite.durationMs });
        if (!selfClosing) suites.push(suite);
      } else if (name === 'testsuite' && closing) suites.pop();
      if (name === 'testcase' && !closing) {
        formats.add('junit');
        finishJunit();
        junit = { file: attrs.file ?? suites.at(-1)?.file ?? null, name: attrs.name ?? '', durationMs: duration(attrs.time, 1000), passed: true };
        if (selfClosing) finishJunit();
      } else if (name === 'testcase' && closing) finishJunit();
      if (!closing && (name === 'failure' || name === 'error') && junit) junit.passed = false;
    }
    const end = tags.length ? tags.at(-1).index + tags.at(-1)[0].length : 0;
    const remainder = xml.slice(end);
    const opening = remainder.lastIndexOf('<');
    xmlPending = opening >= 0 && remainder.length - opening <= MAX_LINE ? remainder.slice(opening) : '';
  }
  finishTap();
  const format = [...formats].join('+') || 'none';
  return { files, tests, runner, format,
    unavailable: formats.size ? null : 'per-test timing unavailable: output was not TAP or JUnit' };
}

/** Iterate a complete log in bounded chunks, discarding only oversized diagnostic lines. */
function* logLines(path) {
  const fd = openSync(path, 'r');
  const decoder = new StringDecoder('utf8');
  const chunk = Buffer.alloc(32 * 1024);
  let pending = '';
  let oversized = false;
  try {
    let count;
    while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      const parts = (pending + decoder.write(chunk.subarray(0, count))).split('\n');
      pending = parts.pop();
      for (const [index, line] of parts.entries()) {
        if ((!oversized || index > 0) && Buffer.byteLength(line, 'utf8') <= MAX_LINE) yield line.replace(/\r$/u, '');
      }
      if (parts.length) oversized = false;
      if (Buffer.byteLength(pending, 'utf8') > MAX_LINE) { pending = ''; oversized = true; }
    }
    pending += decoder.end();
    if (!oversized && pending) yield pending;
  } finally { closeSync(fd); }
}

/** Read the private worker's full output without trusting its bounded diagnostic capture. */
export function timingFromLog(path, runner) {
  return timingFromOutput(logLines(path), runner);
}
