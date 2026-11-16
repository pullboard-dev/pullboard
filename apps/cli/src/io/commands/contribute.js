/** The pullboard contribute command: check a contribution record file and print every parser failure with its rule, fix and skill command [C7]. */
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { CONTRIBUTION_SHAPES } from '../../../../../packages/commits/index.js';
import { MAX_SUMMARY_CHARS } from '../../../../../packages/commits/index.js';
import { contributionSecrets } from '../../../../../packages/commits/index.js';
import { contributionFix } from '../../../../../packages/commits/index.js';
import { parseContributionRecord } from '../../../../../packages/commits/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';

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
  const row = contributionFix('CONTRIB_SECRET');
  return contributionSecrets(text).map(({ line, kind }) => ({ field: `line ${line}`, code: 'CONTRIB_SECRET', where: `line ${line}`,
    rule: `${row.rule} (${kind})`, fix: row.fix, command: row.command.replace('<file>', file) }));
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
 * Run `pullboard contribute check <file> [shape]` and return its exit code: 0 for a record the parser accepts, 1 after printing every failure.
 * Why every failure: a contributor fixes the whole record in one pass instead of one refusal per run; each failure is blanked out and the parser run again.
 * A failure that names no line or key in the block (a missing required field) ends the list, as nothing can be taken out.
 */
export function run(io, { first, second, rest }) {
  if (first !== 'check' || !second) throw new Refused('USAGE', 'use pullboard contribute check <file>', 'pullboard contribute check <file> [shape]');
  const path = isAbsolute(second) ? second : join(io.cwd, second);
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { throw new Refused('NO_FILE', `cannot read ${second}`, 'pass the path of the record file'); }
  const shape = recordShape(text, rest?.[0]);
  const { block, offset } = recordBlock(text);
  const failures = [];
  let current = block;
  while (failures.length < MAX_FAILURES) {
    try { parseContributionRecord(current, shape); break; } catch (error) {
      if (!(error instanceof Refused)) throw error;
      const found = failure(error, second, offset);
      failures.push(found);
      current = blankOut(current, found.field);
      if (current === null) break;
    }
  }
  failures.push(...secretFailures(text, second));
  const summary = summaryOf(text).length;
  io.say(`summary ${summary} of ${MAX_SUMMARY_CHARS} characters`);
  io.result?.({ file: second, shape, ok: failures.length === 0, summary: { length: summary, max: MAX_SUMMARY_CHARS }, failures });
  if (!failures.length) { io.say(`${second}: a ${shape} record the parser accepts`); return 0; }
  for (const item of failures) io.say(`${item.where}: ${item.code}; rule: ${item.rule}; fix: ${item.fix}; skill: ${item.command}`);
  io.say(`${failures.length} failure${failures.length === 1 ? '' : 's'} in ${second}`);
  return 1;
}
