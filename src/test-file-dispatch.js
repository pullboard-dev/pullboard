/** Parent-controlled file admission and one structured result stream [C7]. */
/** @pullboard-module-loads ** */
// Native test files are caller-selected, just as in bin/run-tests.js.
import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';
import { createWriteStream } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { run } from 'node:test';
import * as testReporters from 'node:test/reporters';
import { glob } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { testsNeedBrowser } from './browser-admission.js';
import { takeResource } from './resources.js';
import { reserveTestFileToken } from './test-file-pool.js';
import { TEST_FILE_POOL_ENV } from './test-file-pool.js';
import {
  bindTestRuntime,
  testRuntimeImport,
} from './execution-environment.js';

/** Counter trailers are identified by their structured root-plan boundary, never by parsing test stdout/TAP. */
function trailer(event, afterPlan) {
  return afterPlan && event.type === 'test:diagnostic' && event.data.nesting === 0
    && /^(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) [0-9]/u.test(event.data.message);
}

/** One parent FIFO reservation at a time; transferred actual workers may remain live concurrently. */
function acquisitionQueue() {
  let tail = Promise.resolve();
  return async () => {
    const prior = tail;
    let release;
    tail = new Promise(done => { release = done; });
    await prior;
    return release;
  };
}

/** Feed one event to named live listeners, while ordered reporter data is published separately. */
function notify(stream, event) {
  stream.emit(event.type, event.data);
}

/** Set only this actual worker's legitimately reserved admission before its ordinary runner preload. */
function admissionImport(value, browser, runner) {
  const recorder = testRuntimeImport();
  const source = (recorder ? `await import(${JSON.stringify(recorder)});` : '') + `process.env[${JSON.stringify(TEST_FILE_POOL_ENV)}]=${JSON.stringify(value)};`
    + (browser ? `process.env.PULLBOARD_TEST_BROWSER_OWNER_PID=${JSON.stringify(String(process.pid))};`
      + "if(process.env.PULLBOARD_TEST_BROWSER_BY_LAUNCH==='1')process.env.PULLBOARD_TEST_BROWSER_SLOT='held';"
      + 'delete process.env.PULLBOARD_TEST_BROWSER_BY_LAUNCH;' : '')
    + `await import(${JSON.stringify(pathToFileURL(runner).href)});`;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

/** Observe the actual native ChildProcess without changing spawn; its opaque bootstrap binds one file. */
function fileExitObserver(bootstrap, file) {
  const records = [];
  const source = channel('child_process');
  const observe = ({ process: child }) => {
    if (!child || typeof child.once !== 'function') return;
    records.push({ child, closed: new Promise(done => child.once('close', done)) });
  };
  source.subscribe(observe);
  let closing;
  return () => closing ??= (async () => {
    source.unsubscribe(observe);
    const owned = records.filter(({ child }) => child.spawnfile === process.execPath
      && child.spawnargs?.includes(bootstrap) && Number.isInteger(child.pid) && child.pid > 0);
    if (owned.length > 1) throw new Error('one file admission started more than one actual worker');
    await Promise.all(owned.map(record => record.closed));
    for (const { child } of owned) {
      if (bindTestRuntime(child.pid, file) === false) throw new Error('the actual test worker has no self-reported runtime: ' + file);
    }
    return owned.length;
  })();
}

/**
 * Dispatch each selected file only after its FIFO token, preserving browser-before-CPU admission and
 * the existing per-run concurrency ceiling. Public run() supplies real structured events and errors.
 * Reporter factories consume this single stream once; file stdout is never interpreted as a report.
 */
export function dispatchTestFiles(options, env) {
  const stream = new PassThrough({ objectMode: true });
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const signal = controller.signal;
  const files = options.selectedFiles ?? options.files ?? [];
  const limit = options.concurrency === false ? 1 : options.concurrency === true
    ? Math.max(1, availableParallelism() - 1) : options.concurrency ?? 1;
  const acquire = acquisitionQueue();
  const started = performance.now();
  const blocks = new Map();
  const summaries = [];
  let nextFile = 0;
  let nextBlock = 0;
  let topLevel = 0;
  options.setup?.(stream);

  /** Publish complete file blocks in discovery order without changing nested numbers or Error objects. */
  function flush() {
    while (blocks.has(nextBlock)) {
      const { events, summary } = blocks.get(nextBlock);
      blocks.delete(nextBlock++);
      for (const event of events) {
        const data = event.data;
        stream.write(data.nesting === 0 && Number.isInteger(data.testNumber)
          ? { ...event, data: { ...data, testNumber: data.testNumber + topLevel } } : event);
      }
      topLevel += summary?.counts?.topLevel ?? 0;
    }
  }

  /** Browser waits happen before reserving CPU, and their real lease lasts through the file's exit. */
  async function browserLease(file) {
    if (!env.PULLBOARD_TEST_BROWSER_RESOURCE) return null;
    const byLaunch = env.PULLBOARD_TEST_BROWSER_BY_LAUNCH === '1';
    if (!await testsNeedBrowser(process.cwd(), [file], { byLaunch })) return null;
    signal.throwIfAborted();
    return takeResource({ name: env.PULLBOARD_TEST_BROWSER_RESOURCE,
      capacity: Number(env.PULLBOARD_TEST_BROWSER_CAPACITY), kind: 'test-browser-file', root: process.cwd(),
      onWait() { signal.throwIfAborted(); } });
  }

  /** Start and consume one real file; returning requires its actual process to have exited. */
  async function fileRun(file, index) {
    let browser;
    let token;
    let unlock;
    let drained;
    let fileExited;
    try {
      browser = await browserLease(file);
      signal.throwIfAborted();
      unlock = await acquire();
      signal.throwIfAborted();
      token = await reserveTestFileToken(env, signal);
      signal.throwIfAborted();
      const execArgv = [...options.execArgv];
      const preload = execArgv.indexOf('--import');
      if (preload < 0 || !execArgv[preload + 1]) throw new Error('test-file dispatch requires its ordinary runner preload');
      execArgv[preload + 1] = admissionImport(token.value, browser, execArgv[preload + 1]);
      fileExited = fileExitObserver(execArgv[preload + 1], file);
      const source = run({ ...options, files: [file], shard: undefined, concurrency: 1, signal,
        setup: undefined, execArgv });
      source.once('error', error => controller.abort(error));
      const events = [];
      let summary;
      let afterPlan = false;
      drained = (async () => {
        for await (const event of source) {
          if (event.type === 'test:plan' && event.data.nesting === 0) { afterPlan = true; continue; }
          if (event.type === 'test:summary' && !event.data.file) { summary = event.data; continue; }
          if (trailer(event, afterPlan)) continue;
          notify(stream, event);
          events.push(event);
        }
        if (!summary) throw new Error(`test file ended without a native summary: ${file}`);
        const actualWorkers = await fileExited();
        if (summary.success && actualWorkers !== 1) throw new Error(`test file has no actual worker exit receipt: ${file}`);
        summaries.push(summary);
        blocks.set(index, { events, summary });
        flush();
      })();
      // A failed import can exit before adopting; cleanup of the still-reserved place also unblocks transfer.
      const completed = drained.finally(async () => { await fileExited(); await token.drained(); token.release(); });
      completed.catch(() => {});
      await Promise.race([token.transferred(), completed]);
      unlock();
      unlock = null;
      await completed;
    } finally {
      try { if (drained) await drained; }
      finally {
        try { await fileExited?.(); await token?.drained(); token?.release(); }
        finally { unlock?.(); browser?.release(); }
      }
    }
  }

  /** Keep at most the configured number of files active; aborted queued files are never spawned. */
  async function lane() {
    while (!signal.aborted && nextFile < files.length) {
      const index = nextFile++;
      await fileRun(files[index], index);
    }
  }

  /** Emit one combined native-style summary after every actual file and borrowed descendant has drained. */
  async function finish() {
    try {
      const work = Array.from({ length: Math.min(limit, files.length) }, () => lane().catch(error => {
        controller.abort(error);
        throw error;
      }));
      const outcomes = await Promise.allSettled(work);
      const error = outcomes.find(outcome => outcome.status === 'rejected' && outcome.reason?.name !== 'AbortError');
      if (error) throw error.reason;
      const counts = { tests: 0, suites: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0, topLevel: 0 };
      for (const summary of summaries) for (const key of Object.keys(counts)) counts[key] += summary.counts[key] ?? 0;
      const duration = performance.now() - started;
      const summary = { counts, duration_ms: duration, success: !signal.aborted && summaries.every(value => value.success) };
      const final = [{ type: 'test:plan', data: { nesting: 0, count: counts.topLevel } }];
      for (const [name, key] of [['tests', 'tests'], ['suites', 'suites'], ['pass', 'passed'], ['fail', 'failed'],
        ['cancelled', 'cancelled'], ['skipped', 'skipped'], ['todo', 'todo']]) {
        final.push({ type: 'test:diagnostic', data: { nesting: 0, message: `${name} ${counts[key]}` } });
      }
      final.push({ type: 'test:diagnostic', data: { nesting: 0, message: `duration_ms ${duration}` } });
      final.push({ type: 'test:summary', data: summary });
      for (const event of final) { notify(stream, event); stream.write(event); }
      stream.end();
    } catch (error) { stream.destroy(error); }
    finally { options.signal?.removeEventListener('abort', abort); }
  }
  queueMicrotask(finish);
  return stream;
}

/** Native mode keeps running after a test failure and initializes each public/internal reporter exactly once. */
export async function reportDispatchedTests(options, env, loadCustomReporter) {
  const controller = new AbortController();
  const inputs = [];
  const ends = [];
  let reporterError;
  let successful = false;
  const originalEnv = { ...process.env };
  /** Reporter failures stop new dispatch while existing actual workers drain through their normal signal path. */
  const failed = error => { reporterError ??= error; controller.abort(error); };
  try {
    for (const entry of options.reporters) {
      const builtin = ['tap', 'spec', 'dot', 'junit', 'lcov'].includes(entry.reporter);
      const reporter = builtin ? testReporters[entry.reporter] : await loadCustomReporter(entry.reporter);
      if (typeof reporter !== 'function') throw new Error(`unknown test reporter: ${entry.reporter}`);
      const input = new PassThrough({ objectMode: true });
      const output = input.compose(reporter);
      const terminal = entry.destination === 'stdout' || entry.destination === 'stderr';
      const destination = entry.destination === 'stdout' ? process.stdout
        : entry.destination === 'stderr' ? process.stderr : createWriteStream(resolve(entry.destination));
      const readable = new Promise(done => { output.once('end', done); output.once('close', done); });
      const writable = terminal ? Promise.resolve() : new Promise(done => {
        destination.once('finish', done);
        destination.once('error', error => { failed(error); done(); });
      });
      output.once('error', failed);
      destination.once('error', failed);
      output.pipe(destination);
      ends.push(Promise.all([readable, writable]).finally(() => destination.off('error', failed)));
      inputs.push(input);
    }
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    const source = dispatchTestFiles({ ...options, signal: controller.signal,
      setup(tests) {
        tests.on('test:summary', summary => { if (!summary.file) successful = summary.success; });
      } }, env);
    try {
      for await (const event of source) for (const input of inputs) input.write(event);
    } catch (error) { failed(error); }
  } finally {
    for (const input of inputs) input.end();
    await Promise.all(ends);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
  if (reporterError) throw reporterError;
  return { status: successful ? 0 : 1, signal: null };
}

/** Preserve native CLI option placement, aliases and validation before public dispatch. */
export function nativeFileArguments(args, concurrency, knownNodeOption, optionTakesValue) {
  let files = concurrency.files;
  // Node reads an option only before the files, so every option is placed ahead of them, wherever it was written (#931).
  const placed = [];
  const selectors = [];
  for (let at = 0; at < args.length; at += 1) {
    const argument = args[at];
    if (argument === '--') { selectors.push(...args.slice(at)); break; }
    if (/^--test[-_]name[-_]pattern(?:=|$)/u.test(argument)) {
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : args[++at];
      if (value === undefined) throw new Error('--test-name-pattern requires a value');
      placed.push(`--test-name-pattern=${value}`);
    } else if (/^--test[-_]skip[-_]pattern(?:=|$)/u.test(argument)) {
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : args[++at];
      if (value === undefined) throw new Error('--test-skip-pattern requires a value');
      placed.push(`--test-skip-pattern=${value}`);
    } else if (/^--test[-_]concurrency(?:=|$)/u.test(argument)) {
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : args[++at];
      if (!/^[1-9][0-9]*$/u.test(value ?? '') || !Number.isSafeInteger(Number(value))) {
        throw new Error('--test-concurrency must be a positive integer');
      }
      files = Math.min(files, Number(value));
    } else if (/^--(?:experimental[-_])?test[-_]isolation(?:=none|$)/u.test(argument) &&
      (argument.endsWith('=none') || args[at + 1] === 'none')) {
      throw new Error('bounded browser test files require process isolation; remove --test-isolation=none');
    } else if (argument === '--test-only') {
      // Node would apply it only to cases marked only, so a run would silently skip the rest of the file (#931).
      throw new Error('unknown option --test-only; run-tests does not apply it, so select cases with --test-name-pattern');
    } else if (argument.startsWith('-')) {
      // An option Node does not know would be ignored; name it instead of running without it (#931).
      if (!knownNodeOption(argument)) throw new Error(`unknown option ${argument.split('=', 1)[0]}; check its spelling, or drop it`);
      placed.push(argument);
      if (!argument.includes('=') && optionTakesValue(argument)) {
        if (args[at + 1] === undefined) throw new Error(`${argument} requires a value`);
        placed.push(args[++at]);
      }
    } else selectors.push(argument);
  }
  return { args: [...placed, ...selectors], concurrency: { ...concurrency, files } };
}

/** Convert the validated test CLI into public run() options and one shared reporter configuration. */
export async function testFileOptions(args, env, concurrency, { runner, optionTakesValue, knownNodeOption }) {
  const options = { concurrency: true, isolation: 'process', execArgv: ['--disable-warning=ExperimentalWarning', '--import', runner] };
  const reporters = [];
  const selectors = [];
  const patterns = [];
  const skipPatterns = [];
  const coverageExcludeGlobs = [];
  const coverageIncludeGlobs = [];
  const execArgv = [];
  let expectValue = null;
  for (let index = 0; index < args.length; index += 1) {
    let argument = args[index];
    if (expectValue) {
      expectValue(argument);
      expectValue = null;
      continue;
    }
    if (argument === '--') { selectors.push(...args.slice(index + 1)); break; }
    const valueOption = (name, take) => {
      if (argument === name) { expectValue = take; return true; }
      if (argument.startsWith(`${name}=`)) { take(argument.slice(name.length + 1)); return true; }
      return false;
    };
    if (valueOption('--test-concurrency', value => {
      if (value === 'true') options.concurrency = true;
      else if (value === 'false') options.concurrency = false;
      else if (/^[1-9][0-9]*$/u.test(value)) {
        const requested = Number(value);
        // Validate before clamping: Node's run() accepts a positive uint32, not Infinity or larger integers.
        if (!Number.isSafeInteger(requested) || requested > 4_294_967_295) {
          throw new Error(`invalid --test-concurrency value: ${value}`);
        }
        options.concurrency = requested;
      } else throw new Error(`invalid --test-concurrency value: ${value}`);
    })) continue;
    if (valueOption('--test-name-pattern', value => patterns.push(value))) continue;
    if (valueOption('--test-skip-pattern', value => skipPatterns.push(value))) continue;
    if (valueOption('--test-timeout', value => { options.timeout = Number(value); })) continue;
    if (valueOption('--test-reporter', value => reporters.push(value))) continue;
    if (valueOption('--test-reporter-destination', value => { (options.reporterDestinations ??= []).push(value); })) continue;
    if (valueOption('--test-coverage-include', value => coverageIncludeGlobs.push(value))) continue;
    if (valueOption('--test-coverage-exclude', value => coverageExcludeGlobs.push(value))) continue;
    if (valueOption('--test-coverage-lines', value => { options.lineCoverage = Number(value); })) continue;
    if (valueOption('--test-coverage-branches', value => { options.branchCoverage = Number(value); })) continue;
    if (valueOption('--test-coverage-functions', value => { options.functionCoverage = Number(value); })) continue;
    // Parsed but never applied, so a run would pass silently without the cases it claims: refuse it by name (#931).
    if (argument === '--test-only') throw new Error('unknown option --test-only; run-tests does not apply it, so select cases with --test-name-pattern');
    if (argument === '--experimental-test-coverage') { options.coverage = true; continue; }
    if (argument.startsWith('--experimental-test-isolation=')) {
      options.isolation = argument.slice(argument.indexOf('=') + 1);
      continue;
    }
    if (argument.startsWith('--test-isolation=')) {
      options.isolation = argument.slice(argument.indexOf('=') + 1);
      continue;
    }
    if (argument === '--test-isolation') {
      expectValue = value => { options.isolation = value; };
      continue;
    }
    if (argument === '--experimental-test-isolation') {
      expectValue = value => { options.isolation = value; };
      continue;
    }
    if (argument === '--test-shard') { index += 1; continue; }
    if (argument.startsWith('--test-shard=')) continue;
    if (argument.startsWith('-')) {
      // An option Node does not know would be forwarded and ignored after the files; refuse it by name wherever it appears (#931).
      const name = argument.split('=', 1)[0].replaceAll('_', '-');
      optionTakesValue(name);
      if (!knownNodeOption(name)) throw new Error(`unknown option ${name}; check its spelling, or drop it`);
      execArgv.push(argument);
      if (!argument.includes('=') && optionTakesValue(argument)) {
        if (args[index + 1] === undefined) throw new Error(`${argument} requires a value`);
        execArgv.push(args[++index]);
      }
      continue;
    }
    selectors.push(argument);
  }
  if (expectValue) throw new Error('missing value for a Node test runner option');
  options.execArgv = [...options.execArgv, ...execArgv];
  // Keep native run() from treating true/default or a larger explicit value as unbounded.
  if (options.concurrency !== false) {
    const requested = options.concurrency === true ? concurrency.files : options.concurrency;
    options.concurrency = Math.min(concurrency.files, requested);
  }
  if (selectors.length) {
    const files = [];
    for (const selector of selectors) {
      if (!/[?*[{]/u.test(selector)) {
        files.push(resolve(selector));
        continue;
      }
      const matches = [];
      for await (const match of glob(selector, { cwd: process.cwd() })) matches.push(resolve(match));
      if (!matches.length) throw new Error(`test file pattern matched no files: ${selector}`);
      files.push(...matches.sort());
    }
    options.files = [...new Set(files)];
  }
  if (patterns.length) options.testNamePatterns = patterns;
  if (skipPatterns.length) options.testSkipPatterns = skipPatterns;
  if (coverageExcludeGlobs.length) options.coverageExcludeGlobs = coverageExcludeGlobs;
  if (coverageIncludeGlobs.length) options.coverageIncludeGlobs = coverageIncludeGlobs;
  if (args.includes('--test-shard') || args.some(argument => argument.startsWith('--test-shard='))) {
    const shardArgument = args.find(argument => argument === '--test-shard' || argument.startsWith('--test-shard='));
    const shard = shardArgument === '--test-shard' ? args[args.indexOf(shardArgument) + 1] : shardArgument.slice('--test-shard='.length);
    const match = shard?.match(/^([1-9][0-9]*)\/([1-9][0-9]*)$/u);
    if (!match) throw new Error(`invalid --test-shard value: ${shard ?? '(missing)'}`);
    options.shard = { index: Number(match[1]), total: Number(match[2]) };
  }
  let selectedCandidates = options.files;
  if (!selectedCandidates) {
    const defaults = ['**/*.test.{cjs,mjs,js}', '**/*-test.{cjs,mjs,js}', '**/*_test.{cjs,mjs,js}',
      '**/test-*.{cjs,mjs,js}', '**/test.{cjs,mjs,js}', '**/test/**/*.{cjs,mjs,js}'];
    const matches = new Set();
    for (const pattern of defaults) {
      for await (const file of glob(pattern, { cwd: process.cwd() })) {
        if (!file.split(/[\\/]/u).includes('node_modules')) matches.add(resolve(file));
      }
    }
    selectedCandidates = [...matches].sort();
  }
  options.selectedFiles = selectedCandidates.filter((_file, index) => !options.shard || index % options.shard.total === options.shard.index - 1);
  if (!reporters.length) reporters.push('tap');
  const destinations = options.reporterDestinations ?? (reporters.length === 1 ? ['stdout'] : []);
  if (destinations.length !== reporters.length) throw new Error('each --test-reporter requires a matching --test-reporter-destination');
  options.reporters = reporters.map((reporter, index) => ({ reporter, destination: destinations[index] }));
  delete options.reporterDestinations;
  return { options, env };
}


let nodeOptionsWithValues;
let knownNodeOptions;

/** Read Node option arity from this runtime so supported option values cannot bypass the machine pool. */
export function optionTakesValue(argument) {
  if (!nodeOptionsWithValues) {
    nodeOptionsWithValues = new Set();
    knownNodeOptions = new Set();
    const help = execFileSync(process.execPath, ['--help'], { encoding: 'utf8' });
    for (const line of help.split(/\r?\n/u)) {
      const signature = line.match(/^  (-\S.*?)(?: {2,}|$)/u)?.[1];
      if (!signature) continue;
      for (const option of signature.matchAll(/--?[A-Za-z][A-Za-z0-9-]*/gu)) {
        knownNodeOptions.add(option[0]);
        if (signature.includes('=') && !signature.includes('[=')) nodeOptionsWithValues.add(option[0]);
      }
    }
  }
  return nodeOptionsWithValues.has(argument.replaceAll('_', '-'));
}

/**
 * Whether Node's own CLI knows an option, so run-tests can forward it; any other dash option is a typo or a flag
 * this runner cannot apply.
 *
 * @param {string} argument the option as written, with its value after an equals sign if any
 * @returns {boolean}
 */
export function knownNodeOption(argument) {
  const name = argument.split('=', 1)[0].replaceAll('_', '-');
  optionTakesValue(name);
  return knownNodeOptions.has(name);
}


/** Special native modes keep their existing single native orchestrator and aggregate coverage/watch behavior. */
export function legacyFileMode(args) {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') break;
    if (!argument.startsWith('-')) continue;
    const normalized = argument.replaceAll('_', '-');
    if (/^--(?:watch(?:-|=|$)|experimental-test-coverage(?:=|$)|test-coverage(?:-|=|$))/u.test(normalized)) return true;
    if (!argument.includes('=') && optionTakesValue(argument)) index++;
  }
  return false;
}

/** Retained native CLI path for watch and coverage; normal file runs use parent dispatch. */
export function legacyNativeFileRun(args, env, concurrency, { runner, knownNodeOption, optionTakesValue }) {
  let files = concurrency.files;
  // Node reads an option only before the files, so every option is placed ahead of them, wherever it was written (#931).
  const placed = [];
  const selectors = [];
  for (let at = 0; at < args.length; at += 1) {
    const argument = args[at];
    if (argument === '--') { selectors.push(...args.slice(at)); break; }
    if (/^--test[-_]name[-_]pattern(?:=|$)/u.test(argument)) {
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : args[++at];
      if (value === undefined) throw new Error('--test-name-pattern requires a value');
      placed.push(`--test-name-pattern=${value}`);
    } else if (/^--test[-_]skip[-_]pattern(?:=|$)/u.test(argument)) {
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : args[++at];
      if (value === undefined) throw new Error('--test-skip-pattern requires a value');
      placed.push(`--test-skip-pattern=${value}`);
    } else if (/^--test[-_]concurrency(?:=|$)/u.test(argument)) {
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : args[++at];
      if (!/^[1-9][0-9]*$/u.test(value ?? '') || !Number.isSafeInteger(Number(value))) {
        throw new Error('--test-concurrency must be a positive integer');
      }
      files = Math.min(files, Number(value));
    } else if (/^--(?:experimental[-_])?test[-_]isolation(?:=none|$)/u.test(argument) &&
      (argument.endsWith('=none') || args[at + 1] === 'none')) {
      throw new Error('bounded browser test files require process isolation; remove --test-isolation=none');
    } else if (argument === '--test-only') {
      // Node would apply it only to cases marked only, so a run would silently skip the rest of the file (#931).
      throw new Error('unknown option --test-only; run-tests does not apply it, so select cases with --test-name-pattern');
    } else if (argument.startsWith('-')) {
      // An option Node does not know would be ignored; name it instead of running without it (#931).
      if (!knownNodeOption(argument)) throw new Error(`unknown option ${argument.split('=', 1)[0]}; check its spelling, or drop it`);
      placed.push(argument);
      if (!argument.includes('=') && optionTakesValue(argument)) {
        if (args[at + 1] === undefined) throw new Error(`${argument} requires a value`);
        placed.push(args[++at]);
      }
    } else selectors.push(argument);
  }
  const reporter = args.some((argument) => argument === '--test-reporter' || argument.startsWith('--test-reporter='));
  const selectionReporter = [];
  if (env.PULLBOARD_TEST_SELECTION) {
    const reporters = placed.filter(argument => /^--test-reporter(?:=|$)/u.test(argument)).length;
    const destinations = placed.filter(argument => /^--test-reporter-destination(?:=|$)/u.test(argument)).length;
    if (destinations && destinations !== (reporters || 1)) throw new Error('each --test-reporter requires a matching --test-reporter-destination');
    if (reporter && !destinations) for (let index = 0; index < reporters; index++) selectionReporter.push('--test-reporter-destination=stdout');
    if (!reporter && !env.PULLBOARD_TEST_ACTIONS && !destinations) selectionReporter.push('--test-reporter-destination=stdout');
    selectionReporter.push(`--test-reporter=${fileURLToPath(new URL('../src/test-selection.js', import.meta.url))}`, `--test-reporter-destination=${devNull}`);
  }
  const nodeArgs = [
    '--disable-warning=ExperimentalWarning',
    '--test',
    `--test-concurrency=${files}`,
    ...(!reporter ? ['--test-reporter=tap', ...(env.PULLBOARD_TEST_ACTIONS ? ['--test-reporter-destination=stdout', `--test-reporter=${fileURLToPath(new URL('../src/test-action-reporter.js', import.meta.url))}`, `--test-reporter-destination=${devNull}`] : [])] : []),
    '--import',
    runner,
    ...placed,
    ...selectionReporter,
    ...selectors,
  ];
  return spawnSync(process.execPath, nodeArgs, { env, stdio: 'inherit' });
}

