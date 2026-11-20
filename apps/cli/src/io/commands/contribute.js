/** The pullboard contribute command: check a contribution record file and print every parser failure with its rule, fix and skill command [C7]. */
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { CONTRIBUTION_SHAPES } from '../../../../../packages/commits/index.js';
import { MAX_SUMMARY_CHARS } from '../../../../../packages/commits/index.js';
import { contributionSecrets } from '../../../../../packages/commits/index.js';
import { contributionSecretRefusal } from '../../../../../packages/commits/index.js';
import { contributionFix } from '../../../../../packages/commits/index.js';
import { parseContributionRecord } from '../../../../../packages/commits/index.js';
import { saveAcceptedRecord } from '../../../../../packages/commits/index.js';
import { acceptedRecordsDir } from '../../../../../packages/commits/index.js';
import { githubPullClient as defaultClient } from './add.js';
import { githubRepository as defaultRepository } from './add.js';
import { Refused } from '../../../../../packages/kernel/index.js';

const fs = fileSystemAdapter();

/** The most failures one check reports, so a hopeless file cannot loop forever. */
const MAX_FAILURES = 50;

/**
 * The YAML block of a record file and the line it starts on: the fenced yaml block of an issue form, or the whole file.
 * Why: the intake forms wrap the machine part in prose, and the parser wants only the YAML.
 */
function recordBlock(text) {
  const lines = text.split('\n');
  const open = lines.findIndex(line => /^```ya?ml\s*$/u.test(line));
  if (open < 0) return { block: text, offset: 0 };
  const close = lines.findIndex((line, index) => index > open && /^```\s*$/u.test(line));
  return { block: lines.slice(open + 1, close < 0 ? undefined : close).join('\n'), offset: open + 1 };
}

/**
 * The summary: the prose of the file outside its issue-form front matter and its yaml block, trimmed.
 * Why: the record's machine part is fields; the summary is the only free text, and RFC 0009 limits it.
 */
function summaryOf(text) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/u, '');
  return body.replace(/^```ya?ml\s*$[\s\S]*?^```\s*$/mu, '').trim();
}

/** One failure per secret-looking line, shaped like the parser failures so they print the same way. */
function secretFailures(text, file) {
  return contributionSecrets(text).map(({ line, kind }) => failure(contributionSecretRefusal(line, kind), file, 0));
}

/** The record shape: the shape the person passed after the file, or the issue form's own name line, which is the shape name. */
function recordShape(text, given) {
  const named = text.match(/^---\nname:\s*(\S+)\s*\n/u)?.[1];
  const shape = given ?? named;
  if (!CONTRIBUTION_SHAPES.includes(shape)) {
    throw new Refused('USAGE', `the record shape is ${given ? `"${given}"` : 'not named in the file'}`, `pullboard contribute check <file> <${CONTRIBUTION_SHAPES.join('|')}>`);
  }
  return shape;
}

/** Take the offending line or key out of the block, keeping line numbers, so the next failure can show; false when nothing can be taken out. */
function blankOut(block, field) {
  const lines = block.split('\n');
  const numbered = field.match(/^line (\d+)$/u);
  if (numbered) {
    const at = Number(numbered[1]) - 1;
    if (!lines[at]?.trim() || lines[at].startsWith('#')) return null;
    lines[at] = '#';
    return lines.join('\n');
  }
  const start = lines.findIndex(line => line.startsWith(`${field}:`));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && /^\s/u.test(lines[end])) end += 1;
  for (let at = start; at < end; at += 1) lines[at] = '#';
  return lines.join('\n');
}

/** Split a parser refusal into the field or line, the rule and the fix. */
function failure(error, file, offset) {
  const parts = error.message.replace(/^\[\w+\] /u, '').match(/^field "(.*?)": (.*); fix: (.*)$/su);
  const field = parts?.[1] ?? 'record';
  const where = field.match(/^line (\d+)$/u);
  const row = contributionFix(error.code);
  return { field, code: error.code, where: where ? `line ${Number(where[1]) + offset}` : field,
    rule: parts?.[2] ?? error.message, fix: parts?.[3] ?? row?.fix ?? error.next, command: (row?.command ?? 'pullboard contribute check <file>').replace('<file>', file) };
}

/**
 * Run `pullboard contribute check <file> [shape]` or `pullboard contribute check --issue N <shape>` and return its exit code: 0 for a record the parser accepts, 1 after printing every failure.
 * Why every failure: a contributor fixes the whole record in one pass instead of one refusal per run; each failure is blanked out and the parser run again.
 * A failure that names no line or key in the block (a missing required field) ends the list, as nothing can be taken out.
 * Why the port: the issue form reads GitHub, so a test passes a fake client factory instead of reaching the network; it only reads, never posts.
 */
export function run(io, { first, second, rest, values }, { githubPullClient = defaultClient, githubRepository = defaultRepository } = {}) {
  const issue = values?.issue;
  if ((first !== 'check' && first !== 'accept') || (!second && !issue)) throw new Refused('USAGE', 'use pullboard contribute check <file> or pullboard contribute accept <file>', 'pullboard contribute check <file> [shape]');
  if (first === 'accept' && issue) throw new Refused('USAGE', 'accept reads a record file, not an issue', 'pullboard contribute accept <file> [shape]');
  let text;
  let label = second;
  let given = rest?.[0];
  if (issue) {
    if (!/^[1-9][0-9]*$/u.test(issue)) throw new Refused('USAGE', `--issue takes an issue number, not "${issue}"`, 'pullboard contribute check --issue <number> <shape>');
    label = `issue #${issue}`;
    given = second;
    try { text = String(githubPullClient(io.cwd, githubRepository(io.cwd, 'origin')).readIssue(Number(issue))?.body ?? ''); } catch (error) {
      throw new Refused('ISSUE_READ', `cannot read issue ${issue}: ${error instanceof Refused ? error.message : 'the read failed'}`, 'check gh auth status, the origin remote and the issue number, then run the check again');
    }
  } else {
    const path = isAbsolute(second) ? second : join(io.cwd, second);
    try { text = fs.readFile(path, 'utf8'); } catch { throw new Refused('NO_FILE', `cannot read ${second}`, 'pass the path of the record file'); }
  }
  return check(io, text, label, given, first === 'accept');
}

/** Check one record text under its label and print the result; shared by the file and issue forms so both print the same failures. With accept, a record with no failures is also saved under its hash and the hash printed; a failing record saves nothing. */
function check(io, text, label, given, accept = false) {
  const shape = recordShape(text, given);
  const { block, offset } = recordBlock(text);
  const failures = [];
  let current = block;
  while (failures.length < MAX_FAILURES) {
    try { parseContributionRecord(current, shape); break; } catch (error) {
      if (!(error instanceof Refused)) throw error;
      const found = failure(error, label, offset);
      failures.push(found);
      current = blankOut(current, found.field);
      if (current === null) break;
    }
  }
  failures.push(...secretFailures(text, label));
  const summary = summaryOf(text).length;
  io.say(`summary ${summary} of ${MAX_SUMMARY_CHARS} characters`);
  io.result?.({ file: label, shape, ok: failures.length === 0, summary: { length: summary, max: MAX_SUMMARY_CHARS }, failures });
  if (!failures.length) {
    io.say(`${label}: a ${shape} record the parser accepts`);
    if (accept) io.say(`saved ${saveAcceptedRecord(acceptedRecordsDir(join(io.cwd, '.git', 'pullboard')), block, shape)}`);
    return 0;
  }
  for (const item of failures) io.say(`${item.where}: ${item.code}; rule: ${item.rule}; fix: ${item.fix}; skill: ${item.command}`);
  io.say(`${failures.length} failure${failures.length === 1 ? '' : 's'} in ${label}`);
  return 1;
}
