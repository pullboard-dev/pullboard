/** The stock files `pullboard init` writes quote CLI commands; each must still be accepted by the CLI it ships with [C7]. */
import assert from 'node:assert/strict';
import {
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  relative,
} from 'node:path';
import { test } from 'node:test';
import { runCliInProcess } from '../fixtures/process.js';
import { fixture } from '../fixtures/init/ignore-box.js';

const SKIPPED_FOLDERS = new Set(['.git', 'node_modules']);
const PLACEHOLDER = /^[<[{]|[>\]}]$|\.\.\.|\|/u;
const STOP_TOKENS = new Set(['|', '||', '&&', ';', '>', '>>', '<']);

/** Every text file under a repo, as paths relative to it, skipping Git's own folder and installed packages. */
function repoFiles(root, folder = root) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    if (SKIPPED_FOLDERS.has(entry.name)) return [];
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return repoFiles(root, path);
    return entry.isFile() ? [relative(root, path)] : [];
  });
}

/** The words of one quoted command, honouring simple single and double quotes; null for an unterminated quote. */
function words(text) {
  const out = [];
  let current = null;
  let quote = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null; else current += char;
    } else if (char === '"' || char === '\'') {
      quote = char;
      current ??= '';
    } else if (/\s/u.test(char)) {
      if (current !== null) out.push(current);
      current = null;
    } else {
      current = (current ?? '') + char;
    }
  }
  if (quote) return null;
  if (current !== null) out.push(current);
  return out;
}

/** The concrete `pullboard <command> ...` lines quoted in backticks in one stock file's text. */
function quotedCommands(text) {
  const found = [];
  for (const [, quoted] of text.matchAll(/`([^`\n]+)`/gu)) {
    const parts = words(quoted.trim());
    if (!parts || parts[0] !== 'pullboard' || !/^[a-z][a-z-]*$/u.test(parts[1] ?? '')) continue;
    const end = parts.findIndex(part => STOP_TOKENS.has(part));
    const args = (end < 0 ? parts : parts.slice(0, end)).slice(1);
    found.push({ quoted: quoted.trim(), args });
  }
  return found;
}

/**
 * The argv one quoted command runs with: as quoted when it is already a dry run and names no placeholder, else
 * its command and flags followed by --help, with each placeholder replaced by a plain word. Never a mutating form.
 */
function safeArgs({ args }) {
  const placeholders = args.some(arg => PLACEHOLDER.test(arg));
  if (args.includes('--dry-run') && !placeholders) return args;
  return [...args.map(arg => (PLACEHOLDER.test(arg) ? 'x' : arg)).filter(arg => arg !== '--dry-run'), '--help'];
}

/** The refusal code one failed run printed, from its JSON error document or else its text. */
function refusalCode(result) {
  try {
    const code = JSON.parse(result.stdout)?.error?.code;
    if (code) return code;
  } catch { /* not a JSON document: read the text */ }
  const text = `${result.failure ?? ''}\n${result.stderr}\n${result.stdout}`;
  return /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/u.exec(text)?.[0] ?? (/unknown option|unknown flag/iu.test(text) ? 'UNKNOWN_FLAG' : `EXIT_${result.status}`);
}

/** Run each distinct quoted command of each stock file; the refusals found, as file, command and code. */
async function stockRefusals(box, files) {
  const refusals = [];
  const answers = new Map();
  let ran = 0;
  for (const file of files) {
    for (const command of quotedCommands(readFileSync(join(box.root, file), 'utf8'))) {
      const argv = safeArgs(command);
      const key = argv.join('\0');
      if (!answers.has(key)) {
        answers.set(key, await runCliInProcess([...argv, '--json'], { cwd: box.root, env: box.env }));
        ran += 1;
      }
      const result = answers.get(key);
      const text = `${result.failure ?? ''}${result.stderr}`;
      if (result.status !== 0 || /unknown option|unknown flag/iu.test(text)) refusals.push({ file, command: command.quoted, code: refusalCode(result) });
    }
  }
  return { refusals, ran };
}

/** Fail with every refusal named by file, quoted command and refusal code. */
function assertAccepted({ refusals }) {
  assert.deepEqual(refusals, [], refusals.map(({ file, command, code }) => `${file}: \`${command}\` is refused with ${code}`).join('\n'));
}

/** A scratch repo with the stock files init writes; init starts no view and no git maintenance scheduler here. */
async function initialized(t) {
  const box = fixture(t);
  assert.equal(box.env.GIT_CONFIG_GLOBAL, '/dev/null', 'git maintenance start stays off: git has no global config');
  const result = await box.invoke('init', '--no-open');
  assert.equal(result.code, 0, result.stderr);
  const stock = repoFiles(box.root).filter(file => /\.(?:md|mdc|txt|json|toml|ya?ml)$/u.test(file) && file !== 'pullboard.json');
  assert.ok(stock.includes('AGENTS.md'), `init wrote AGENTS.md among ${stock.join(', ')}`);
  return { box, stock };
}

test('cli.io-init.stock-commands-accepted: clause 1: every pullboard command quoted in backticks in the stock files init writes runs in its help or dry form with no refusal [C7]', async t => {
  const { box, stock } = await initialized(t);
  const outcome = await stockRefusals(box, stock);
  assert.ok(outcome.ran > 0, 'the stock files quote at least one pullboard command');
  assertAccepted(outcome);
});

test('cli.io-init.stock-command-refusal-named: clause 2: a stock file quoting a command the CLI refuses fails with the file, the quoted command and the refusal code [C7]', async t => {
  const { box } = await initialized(t);
  const quoted = 'pullboard status --no-such-flag';
  const direct = await runCliInProcess(['status', '--no-such-flag', '--json'], { cwd: box.root, env: box.env });
  assert.notEqual(direct.status, 0, 'the CLI refuses an unknown flag');
  const code = refusalCode(direct);
  writeFileSync(join(box.root, 'REFUSED.md'), `# Stock text\n\nRun \`${quoted}\` first.\n`);
  const outcome = await stockRefusals(box, ['REFUSED.md']);
  assert.deepEqual(outcome.refusals, [{ file: 'REFUSED.md', command: quoted, code }]);
  assert.throws(() => assertAccepted(outcome), error => {
    assert.ok(error.message.includes('REFUSED.md'), error.message);
    assert.ok(error.message.includes(`\`${quoted}\``), error.message);
    assert.ok(error.message.includes(code), error.message);
    return true;
  });
});
