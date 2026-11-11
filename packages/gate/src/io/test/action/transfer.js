/** Select content-keyed receipts for literal runner commands before a fleet exchange [C7]. */
import { readFileSync } from 'node:fs';
import {
  basename,
  resolve,
} from 'node:path';
import { gateStages } from '../../stages.js';
import { literalShellWords } from '../../../../../kernel/index.js';
import {
  RECORD_ONLY_PREFIX,
  testActionKeys,
  testResultStore,
} from './cache.js';
import {
  packTestResults,
  selectedTestResults,
} from '../store.js';

const VALUE_OPTIONS = new Set(['--test-name-pattern', '--test_name_pattern', '--test-skip-pattern', '--test_skip_pattern',
  '--test-concurrency', '--test_concurrency', '--test-timeout', '--test_timeout', '--test-reporter', '--test_reporter',
  '--test-reporter-destination', '--test_reporter_destination', '--test-shard', '--test_shard']);
const TEST_FILE = /\.(?:test|spec)\.[cm]?js$/u;

/** Parse only literal file selectors; opaque shell commands keep ordinary fresh execution. */
function selection(args) {
  const files = [];
  const options = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (arg.startsWith('--')) {
      options.push(arg);
      if (!arg.includes('=') && VALUE_OPTIONS.has(arg)) {
        if (!args[at + 1]) return null;
        options.push(args[++at]);
      }
    } else if (TEST_FILE.test(arg)) files.push(arg.replace(/^\.\//u, ''));
    else return null;
  }
  return { files: files.length ? files : undefined, options };
}

/** Expand only this checkout's literal npm test/gate scripts, with a bounded recursion depth. */
function invocations(root, command, depth = 0) {
  if (depth > 3) return [];
  const found = [];
  for (const stage of gateStages(command) ?? []) for (const component of stage.pipeline) {
    const words = literalShellWords(component);
    if (!words) continue;
    if (words.length === 3 && words[0] === 'npm' && words[1] === 'run') {
      try {
        const script = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts?.[words[2]];
        if (typeof script === 'string') found.push(...invocations(root, script, depth + 1));
      } catch { /* Unknown package scripts transfer nothing. */ }
      continue;
    }
    // A record-only run (census, main comparison) sends no stored green but asks for its own greens back.
    const record = words[0] === RECORD_ONLY_PREFIX;
    if (record) words.shift();
    if (!['node', 'node.exe'].includes(basename(words[0] ?? '')) || words.length < 2
      || resolve(root, words[1]) !== resolve(root, 'apps/cli/src/io/run/tests.js')) continue;
    const selected = selection(words.slice(2));
    if (selected) found.push(record ? { ...selected, record } : selected);
  }
  return found;
}

/**
 * Carry only records whose content and exact selection this request reaches. Runtime variants
 * stay separate inside each input bucket; the actual executor chooses its own context key.
 * No store scan or inferred caller Node version can manufacture a matching worker receipt.
 */
export async function prepareTestResultExchange(root, command, commit) {
  try {
    const inputs = new Set();
    const recorded = new Set();
    for (const { record, ...selected } of invocations(root, command)) {
      // Store upkeep scans every memo and record, minutes at load, so a dispatch's request never runs it (9 Nov) [C7].
      const keys = await testActionKeys(root, { commit, ...selected, maintain: false });
      for (const value of keys.values()) if (value.inputKey) (record ? recorded : inputs).add(value.inputKey);
    }
    if (!inputs.size && !recorded.size) return null;
    const store = testResultStore(root);
    const inputKeys = [...new Set([...inputs, ...recorded])].sort();
    // A record-only key is named so its greens come back, but its stored greens never go out.
    return { store, inputKeys, packet: inputs.size ? packTestResults(selectedTestResults(store, [...inputs].sort())) : null };
  } catch { return null; }
}
