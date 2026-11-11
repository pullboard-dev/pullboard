#!/usr/bin/env node
/** Source-only test waits/ports lint; debt is a ceiling, never a reason to add another wait [C7]. */
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { blobOid } from '../static/cache.js';
import { lex } from '../scan.js';
import { lineAt } from '../scan.js';
import { readText } from '../scan.js';
import { report } from '../scan.js';
import { walk } from '../scan.js';

const BASELINE_URL = new URL('../../../data/baselines/test-waits-baseline.json', import.meta.url);
const TEST_SOURCE = /^(?!.*(?:^|\/)src\/)(?:(?:packages|apps)\/[^/]+\/(?:tests|journeys)\/.*\.[cm]?js$)|\.(?:test|spec)\.[cm]?js$/u; // tests/ and journeys/ outside src [V32]

/** Return a matching closing bracket from masked code, without interpreting callbacks. */
function closingAt(code, open) {
  let depth = 0;
  for (let at = open; at < code.length; at++) {
    if ('([{'.includes(code[at])) depth++;
    else if (')]}'.includes(code[at]) && --depth === 0) return at;
  }
  return code.length;
}

/** Read one balanced argument list from lexer-masked code, preserving original offsets. */
function argumentsAt(code, open) {
  const values = [];
  const stack = [];
  let start = open + 1;
  for (let index = start; index < code.length; index++) {
    const char = code[index];
    if ('([{'.includes(char)) stack.push(char);
    else if (')]}'.includes(char)) {
      if (!stack.length) { values.push({ start, text: code.slice(start, index).trim() }); return values; }
      stack.pop();
    } else if (char === ',' && !stack.length) { values.push({ start, text: code.slice(start, index).trim() }); start = index + 1; }
  }
  return values;
}

/** Resolve only literal integers and unambiguous constant aliases, without evaluating test code. */
function numericConstants(code) {
  const declarations = new Map();
  for (const match of code.matchAll(/\bconst\s+([\w$]+)\s*=\s*([\w$]+)\s*(?=[,;\n])/gu)) {
    const values = declarations.get(match[1]) ?? [];
    values.push(match[2]); declarations.set(match[1], values);
  }
  /** An ambiguous binding or cycle has no statically demonstrated numeric value. */
  function value(text, seen = new Set()) {
    if (/^\d[\d_]*$/u.test(text)) return Number(text.replaceAll('_', ''));
    if (seen.has(text)) return null;
    const entries = declarations.get(text);
    if (entries?.length !== 1) return null;
    seen.add(text);
    return value(entries[0], seen);
  }
  return value;
}

/** Identify timers/promises aliases using real import declarations rather than quoted fixtures. */
function promiseTimers(source, code) {
  const names = new Set(['sleep', 'delay']);
  for (const match of source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*(['"])node:timers\/promises\2/gu)) {
    if (!/^import\b/u.test(code.slice(match.index))) continue;
    for (const binding of match[1].split(',')) {
      const timer = /^\s*setTimeout(?:\s+as\s+([\w$]+))?\s*$/u.exec(binding);
      if (timer) names.add(timer[1] ?? 'setTimeout');
    }
  }
  for (const match of source.matchAll(/\bimport\s*\*\s*as\s*([\w$]+)\s*from\s*(['"])node:timers\/promises\2/gu)) {
    if (/^import\b/u.test(code.slice(match.index))) names.add(match[1] + '.setTimeout');
  }
  for (const match of source.matchAll(/\bimport\s+([\w$]+)\s+from\s*(['"])node:timers\/promises\2/gu)) {
    if (/^import\b/u.test(code.slice(match.index))) names.add(match[1] + '.setTimeout');
  }
  const promisifiers = new Set();
  for (const match of source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*(['"])node:util\2/gu)) {
    if (!/^import\b/u.test(code.slice(match.index))) continue;
    for (const binding of match[1].split(',')) {
      const imported = /^\s*promisify(?:\s+as\s+([\w$]+))?\s*$/u.exec(binding);
      if (imported) promisifiers.add(imported[1] ?? 'promisify');
    }
  }
  for (const match of source.matchAll(/\bimport\s*\*\s*as\s*([\w$]+)\s*from\s*(['"])node:util\2/gu)) {
    if (/^import\b/u.test(code.slice(match.index))) promisifiers.add(match[1] + '.promisify');
  }
  for (const match of source.matchAll(/\bimport\s+([\w$]+)\s+from\s*(['"])node:util\2/gu)) {
    if (/^import\b/u.test(code.slice(match.index))) promisifiers.add(match[1] + '.promisify');
  }
  for (const match of code.matchAll(/\bconst\s+([\w$]+)\s*=\s*([\w$.]+)\s*\(\s*(?:setTimeout|globalThis\s*\.\s*setTimeout)\s*\)\s*(?=[,;\n])/gu)) {
    if (promisifiers.has(match[2].replace(/\s/gu, ''))) names.add(match[1]);
  }
  return { names, promisifiers };
}

/** Identify node:test callback names so a fixed timer resolving a done parameter is reported. */
function testCallbackNames(source, code) {
  const names = new Set();
  for (const match of source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*(['"])node:test\2/gu)) {
    if (!/^import\b/u.test(code.slice(match.index))) continue;
    for (const binding of match[1].split(',')) {
      const imported = /^\s*(?:test|it)(?:\s+as\s+([\w$]+))?\s*$/u.exec(binding);
      if (imported) names.add(imported[1] ?? binding.trim().split(/\s+/u)[0]);
    }
  }
  for (const match of source.matchAll(/\bimport\s*\*\s*as\s*([\w$]+)\s*from\s*(['"])node:test\2/gu)) {
    if (/^import\b/u.test(code.slice(match.index))) { names.add(match[1] + '.test'); names.add(match[1] + '.it'); }
  }
  for (const match of source.matchAll(/\bimport\s+([\w$]+)\s+from\s*(['"])node:test\2/gu)) {
    if (/^import\b/u.test(code.slice(match.index))) names.add(match[1]);
  }
  return names;
}

/** Match timer callbacks that only settle the enclosing Promise resolver. */
function resolvesFromTimerCallback(callback, resolver) {
  if (callback === resolver) return true;
  const name = resolver.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const resolveCall = `${name}\\s*\\([^)]*\\)\\s*;?`;
  const arrow = `(?:\\(\\s*(?:[\\w$]+\\s*)?\\)|[\\w$]+)\\s*=>\\s*(?:\\{\\s*)?${resolveCall}\\s*\\}?`;
  const fn = `function\\s*\\(\\s*(?:[\\w$]+\\s*)?\\)\\s*(?:\\{\\s*)?${resolveCall}\\s*\\}?`;
  return new RegExp(`^(?:${arrow}|${fn})$`, 'u').test(callback);
}

/** Find callbacks passed to node:test with a completion parameter and their fixed timer waits. */
function testCallbackTimerSites(code, testNames, numeric) {
  const sites = [];
  for (const name of testNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const testCall = new RegExp(`(?<![\\w$.])${escaped}\\s*\\(`, 'gu');
    for (const match of code.matchAll(testCall)) {
      const args = argumentsAt(code, code.indexOf('(', match.index));
      const callback = args.slice(1).find(argument => /^(?:async\s+)?(?:\([^)]*\)\s*=>|[\w$]+\s*=>|function\s*\()/u.test(argument.text));
      if (!callback) continue;
      const params = /^(?:async\s+)?(?:\(\s*([\w$]+)(?:\s*,\s*([\w$]+)(?:\s*,[^)]*)?)?\s*\)|([\w$]+)|function\s*\(\s*([\w$]+)(?:\s*,\s*([\w$]+)(?:\s*,[^)]*)?)?\s*\))\s*(?:=>)?/u.exec(callback.text);
      const doneNames = [params?.[2], params?.[5]].filter(Boolean);
      if (!doneNames.length) continue;
      const callbackStart = callback.start + code.slice(callback.start).search(/\S/u);
      for (const timer of callback.text.matchAll(/\bsetTimeout\s*\(/gu)) {
        const argsAt = code.indexOf('(', callbackStart + timer.index);
        const timerArgs = argumentsAt(code, argsAt);
        if (!doneNames.some(done => resolvesFromTimerCallback(timerArgs[0]?.text ?? '', done)) || !(numeric(timerArgs[1]?.text ?? '') > 0)) continue;
        sites.push(callbackStart + timer.index);
      }
    }
  }
  return sites;
}

/** Find positive-delay intervals that can run work; empty keepalives and race watchdogs do not poll conditions. */
function intervalPollSites(code, numeric) {
  const sites = [];
  for (const interval of code.matchAll(/\bsetInterval\s*\(/gu)) {
    const callAt = interval.index;
    if (isPromiseRaceTimeout(code, callAt)) continue;
    const args = argumentsAt(code, code.indexOf('(', callAt));
    const callback = args[0]?.text ?? '';
    const emptyArrow = /^(?:\(\s*(?:[\w$]+\s*)?\)|[\w$]+)\s*=>\s*\{\s*\}$/u.test(callback);
    const emptyFunction = /^function\s*(?:[\w$]+\s*)?\([^)]*\)\s*\{\s*\}$/u.test(callback);
    if (!(numeric(args[1]?.text ?? '') > 0) || emptyArrow || emptyFunction) continue;
    sites.push(callAt);
  }
  return sites;
}

/** Exclude Promise timers nested in Promise.race, where the timeout bounds an event wait. */
function isPromiseRaceTimeout(code, at) {
  return [...code.matchAll(/\bPromise\s*\.\s*race\s*\(/gu)].some(match => {
    const open = code.indexOf('(', match.index);
    return open < at && at < closingAt(code, open);
  });
}

/** Return the innermost lexical block at a binding, using the already masked source. */
function enclosingBlock(code, at) {
  const stack = [];
  for (let index = 0; index < at; index++) {
    if ('([{'.includes(code[index])) stack.push(index);
    else if (')]}'.includes(code[index])) stack.pop();
  }
  return stack.findLast(index => code[index] === '{') ?? -1;
}

/** Find literal programs written to JavaScript fixtures or node-shebang executables, never ordinary example strings. */
function emittedFixturePrograms(source, { code, strings }) {
  const programs = new Map();
  for (const call of code.matchAll(/\bwriteFileSync\s*\(/gu)) {
    const args = argumentsAt(code, code.indexOf('(', call.index));
    if (!args[1]) continue;
    let start = args[1].start + code.slice(args[1].start).search(/\S/u);
    if (/^[\w$]+$/u.test(args[1].text)) {
      const name = args[1].text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const bindings = [...code.matchAll(new RegExp(`\\bconst\\s+${name}\\s*=\\s*`, 'gu'))].filter(binding => {
        const block = enclosingBlock(code, binding.index);
        return binding.index < call.index && (block < 0 || closingAt(code, block) > call.index);
      });
      const binding = bindings.at(-1);
      if (!binding) continue;
      start = binding.index + binding[0].length;
    }
    const literal = strings.find(row => row.start === start);
    if (!literal || source[start] !== '`') continue;
    const target = source.slice(args[0].start, args[1].start - 1);
    if (!/\.[cm]?js['"`]/u.test(target) && !/^#![^\n]*\bnode\b/u.test(literal.text)) continue;
    const text = literal.text.split('');
    // Interpolations execute in the parent and are already scanned there; they are not fixture source text.
    for (const match of literal.text.matchAll(/\$\{/gu)) {
      if (text[match.index] !== '$') continue;
      const brace = start + 1 + match.index + 1;
      if (code.slice(brace - 1, brace + 1) !== '${') continue;
      const end = Math.min(closingAt(code, brace) - start, text.length);
      for (let index = match.index; index < end; index++) if (text[index] !== '\n') text[index] = ' ';
    }
    programs.set(start, { source: text.join(''), start: start + 1 });
  }
  return [...programs.values()];
}

/** Name executable waits and fixed socket ports, including emitted fixture programs, without running source. */
export function testWaitSites(source, path, scanFixtures = true) {
  const lexed = lex(source);
  const { code } = lexed;
  const numeric = numericConstants(code);
  const { names: waits, promisifiers } = promiseTimers(source, code);
  const testNames = testCallbackNames(source, code);
  const found = [];
  const positions = new Set();
  /** Each diagnostic retains its actual source position and independently ratcheted category. */
  function add(at, kind, text) {
    const key = at + ':' + kind;
    if (positions.has(key)) return;
    positions.add(key);
    found.push({ path, line: lineAt(source, at), kind, text });
  }
  for (const match of code.matchAll(/\bawait\s+([\w$]+(?:\s*\.\s*[\w$]+)?)\s*\(/gu)) {
    if (waits.has(match[1].replace(/\s/gu, ''))) add(match.index, 'sleep', 'real sleep; wait for an observable event or advance an injected clock');
  }
  // Inline promisification is a wait only when the promisifier is an actual node:util import.
  for (const match of code.matchAll(/\bawait\s+([\w$]+(?:\s*\.\s*[\w$]+)?)\s*\(\s*(?:setTimeout|globalThis\s*\.\s*setTimeout)\s*\)\s*\(/gu)) {
    if (promisifiers.has(match[1].replace(/\s/gu, ''))) add(match.index, 'sleep', 'real sleep; wait for an observable event or advance an injected clock');
  }
  // Only a sole-resolver timer is a naked delay. Event subscriptions and timeout failure races do not match.
  const timerPromise = /\bnew\s+Promise\s*\(\s*(?:\(?\s*([\w$]+)(?:\s*,\s*[\w$]+)*\s*\)?\s*=>|function\s*\(\s*([\w$]+)(?:\s*,\s*[\w$]+)*\s*\))\s*(?:\{\s*)?setTimeout\s*\(/gu;
  for (const match of code.matchAll(timerPromise)) {
    const resolver = match[1] ?? match[2];
    const setTimeoutAt = match.index + match[0].lastIndexOf('setTimeout');
    if (isPromiseRaceTimeout(code, match.index)) continue;
    const timerOpen = code.indexOf('(', setTimeoutAt);
    const timerArgs = argumentsAt(code, timerOpen);
    if (!resolvesFromTimerCallback(timerArgs[0]?.text ?? '', resolver)) continue;
    const promiseOpen = code.indexOf('(', match.index);
    if (/\.\s*(?:on|once|addEventListener)\s*\(/u.test(code.slice(promiseOpen, closingAt(code, promiseOpen)))) continue;
    add(setTimeoutAt, 'sleep', 'sole-resolver timer wait; wait for an observable event or advance an injected clock');
  }
  for (const at of testCallbackTimerSites(code, testNames, numeric)) {
    add(at, 'sleep', 'test completion waits on a fixed timer; await the tested event or condition');
  }
  for (const at of intervalPollSites(code, numeric)) {
    add(at, 'poll', 'positive fixed interval with an active callback; await an observable event or condition instead');
  }
  // Poll intervals are a separate category even when they also contain an independently forbidden sleep.
  for (const match of code.matchAll(/\b(?:while|for)\s*\(/gu)) {
    const conditionOpen = code.indexOf('(', match.index);
    const conditionEnd = closingAt(code, conditionOpen);
    const offset = code.slice(conditionEnd + 1).search(/\S/u);
    if (offset < 0) continue;
    const open = conditionEnd + 1 + offset;
    const end = code[open] === '{' ? closingAt(code, open) : code.indexOf(';', open);
    const bodyStart = code[open] === '{' ? open + 1 : open;
    const body = code.slice(bodyStart, end < 0 ? code.length : end);
    for (const call of body.matchAll(/\bawait\s+([\w$]+(?:\s*\.\s*[\w$]+)?)\s*\(/gu)) {
      if (!waits.has(call[1].replace(/\s/gu, ''))) continue;
      const args = argumentsAt(body, body.indexOf('(', call.index));
      if (numeric(args[0]?.text ?? '') > 0) add(bodyStart + call.index, 'poll', 'fixed-delay polling; await the observable condition without sleeping between probes');
    }
  }
  for (const match of code.matchAll(/(?:\.\s*(?:listen|connect|createConnection)|(?<![\w$.])(?:connect|createConnection))\s*\(/gu)) {
    const args = argumentsAt(code, code.indexOf('(', match.index));
    const first = args[0]?.text ?? '';
    const port = first.startsWith('{') ? /\bport\s*:\s*([\w$]+)/u.exec(first)?.[1] : first;
    const value = numeric(port ?? '');
    if (value > 0 && value <= 65535) add(match.index, 'port', 'fixed TCP port; bind port 0 and share the allocated address');
  }
  if (scanFixtures) {
    for (const program of emittedFixturePrograms(source, lexed)) {
      const firstLine = lineAt(source, program.start);
      for (const row of testWaitSites(program.source, path, false)) {
        found.push({ ...row, line: firstLine + row.line - 1 });
      }
    }
  }
  return found.sort((left, right) => left.line - right.line || left.kind.localeCompare(right.kind));
}

/** Inspect test modules and their helpers as text; never import them or open a socket. */
export function testWaitReport(root, { cache = null } = {}) {
  return walk(root, TEST_SOURCE).flatMap(path => {
    const text = readText(root, path);
    return cache ? cache.get(path, blobOid(text), () => testWaitSites(text, path)) : testWaitSites(text, path);
  });
}

/** Count each category per file so deleting one kind cannot pay for another kind of violation. */
export function testWaitCounts(problems) {
  const counts = {};
  for (const { path, kind } of problems) {
    counts[path] ??= {};
    counts[path][kind] = (counts[path][kind] ?? 0) + 1;
  }
  return counts;
}

/** Refuse new files and per-category growth while allowing existing debt to disappear. */
export function testWaitGrowth(problems, baseline) {
  const counts = {};
  return problems.filter(problem => {
    const key = problem.path + ':' + problem.kind;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts[key] > (baseline[problem.path]?.[problem.kind] ?? 0);
  });
}

/** An explicit updater only lowers ceilings; it refuses before writing if any new debt exists. */
export function tightenTestWaitBaseline(problems, baseline) {
  const growth = testWaitGrowth(problems, baseline);
  if (growth.length) throw new Error(growth.map(row => `${row.path}:${row.line}: ${row.text}`).join('\n'));
  return testWaitCounts(problems);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv.slice(2).find(value => !value.startsWith('--')) ?? process.cwd());
  const problems = testWaitReport(root);
  if (process.argv.includes('--report')) report(problems);
  else {
    const baseline = JSON.parse(readFileSync(BASELINE_URL, 'utf8'));
    if (process.argv.includes('--ratchet')) writeFileSync(BASELINE_URL, JSON.stringify(tightenTestWaitBaseline(problems, baseline), null, 2) + '\n');
    else report(testWaitGrowth(problems, baseline));
  }
}
