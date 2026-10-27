/** Classify only supported literal Node and grep file operands; unknown shell grammar stays untouched [C7]. */
import { literalShellWords } from './literal-shell-words.js';

const NODE_DATA = new Set(['--test-name-pattern', '--test-skip-pattern', '--test-reporter', '--test-reporter-destination', '--test-concurrency', '--test-timeout', '--test-shard', '--import', '--require', '-r', '--loader', '--experimental-loader', '--conditions', '-C', '--input-type', '--disable-warning', '--title', '-e', '--eval', '-p', '--print']);
const NODE_FLAGS = new Set(['--test', '--experimental-vm-modules', '--experimental-test-coverage', '--enable-source-maps', '--no-warnings']);
const GREP_DATA = new Set(['-e', '--regexp', '-A', '-B', '-C', '--after-context', '--before-context', '--context', '-m', '--max-count', '--include', '--exclude', '--exclude-dir', '--label']);

/** Node's script argument is a file; only native test mode and the known test runner accept more test files. */
function nodeFiles(words) {
  const files = [];
  let testMode = false;
  let script = false;
  let positional = false;
  for (let index = 1; index < words.length; index += 1) {
    const value = words[index];
    if (!positional && value === '--') { positional = true; continue; }
    if (!positional && NODE_DATA.has(value)) {
      if (++index >= words.length) return [];
      if (['-e', '--eval', '-p', '--print'].includes(value)) return files;
      continue;
    }
    if (!positional && value.startsWith('-')) {
      if (/^(?:--eval|--print|-e|-p)=/u.test(value)) return files;
      if (value === '--test') testMode = true;
      else if (!NODE_FLAGS.has(value) && !NODE_DATA.has(value.split('=')[0])) return [];
      continue;
    }
    if (script && !testMode) break;
    files.push(index);
    if (!script) {
      script = true;
      testMode ||= value === 'bin/run-tests.js' || value === './bin/run-tests.js';
      if (!testMode) break; // Every later word belongs to the ordinary script, not Node's options.
    }
  }
  return files;
}

/** Grep's first ordinary argument is pattern data unless -e/-f already supplied a pattern. */
function grepFiles(words) {
  const files = [];
  let pattern = false;
  let positional = false;
  for (let index = 1; index < words.length; index += 1) {
    const value = words[index];
    if (!positional && value === '--') { positional = true; continue; }
    if (!positional && (GREP_DATA.has(value) || value === '-f' || value === '--file')) {
      if (++index >= words.length) return [];
      if (['-e', '--regexp', '-f', '--file'].includes(value)) pattern = true;
      if (value === '-f' || value === '--file') files.push(index);
      continue;
    }
    if (!positional && value.startsWith('-')) {
      if (/^-[EFGivwxclLqnsHhrobRIUVazZ]+$/u.test(value)) continue;
      if (/^--(?:regexp|file|include|exclude|exclude-dir|label|max-count|context|after-context|before-context)=/u.test(value)) {
        pattern ||= value.startsWith('--regexp=') || value.startsWith('--file=');
        continue;
      }
      return [];
    }
    if (!pattern) pattern = true;
    else files.push(index);
  }
  return files;
}

/** Return original spans of proven file operands, preserving all whitespace, quotes and operators around them. */
export function pathMapFileWords(command) {
  const selected = [];
  let segment = [];
  let comment = false;
  /** Classify one literal simple command without expanding or evaluating any shell input. */
  const finish = () => {
    const words = segment.map(token => literalShellWords(token.raw));
    if (words.every(value => value?.length === 1)) {
      const values = words.map(value => value[0]);
      const name = values[0]?.split('/').at(-1);
      const files = ['node', 'nodejs'].includes(name) ? nodeFiles(values) : name === 'grep' ? grepFiles(values) : [];
      for (const index of files) selected.push(segment[index]);
    }
    segment = [];
  };
  for (const token of command.matchAll(/&&|\|\||[;&|<>()[\]\n]|(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\[\s\S]|[^\s;&|<>()'"\[\]])+/gu)) {
    if (comment) {
      if (token[0] === '\n') { comment = false; finish(); }
      continue;
    }
    if (token[0].startsWith('#')) { segment = []; comment = true; continue; }
    if (/^(?:&&|\|\||[;&|\n])$/u.test(token[0])) finish();
    else segment.push({ raw: token[0], start: token.index, end: token.index + token[0].length });
  }
  finish();
  return selected;
}
