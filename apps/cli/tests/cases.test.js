/** @pullboard-world-pin: clause 1 reads the e2e test files themselves to prove the split kept every case. */
/** @pullboard-test-input apps/cli/journeys/merged/e2e.test.js apps/cli/journeys/list/board.test.js apps/cli/tests/io/commands/gate/slot.test.js */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/** Where the three files are now; they were test/e2e.test.js, test/e2e-board.test.js and test/e2e-gate-slot.test.js. */
const FILES = ['apps/cli/journeys/merged/e2e.test.js', 'apps/cli/tests/io/commands/list/board.test.js', 'apps/cli/tests/io/commands/gate/slot.test.js'];

/** Each original case as its quote and exact title; a template quote is a case a loop declares once per mode. */
const CASES = [
  ["'", "init writes config, spec, agent docs and hooks once, and never clobbers [I1, I2]"],
  ["\"", "init's spec has its sections and no rows, and the README's example fits under them as written [I1, S8]"],
  ["\"", "the coordinator's resume names its next step from the spec and the board, stage by stage [N32, I9]"],
  ["'", "spec check lints both files; spec view writes one page into the git dir [S6, S7]"],
  ["'", "items and commit headers cite doctrine rows by namespace; bare collisions warn [A5]"],
  ["'", "clause 1: the board lives in the git common dir; every worktree sees it; nothing is committed [B1, B3]"],
  ["'", "items cite spec ids that exist [B6]"],
  ["'", "a lane commits only inside its folders; an unjoined worktree cannot commit [L3, L4]"],
  ["\"", "a lane merges main's foreign changes but still refuses its own and non-main foreign changes [L3]"],
  ["'", "submit needs a clean tree, nothing untracked, and the gate green at HEAD [V4, B9]"],
  ["'", "pre-push keeps its machine gate slot until the hook check finishes [C3,Q4]"],
  ["'", "explicit and trunk pre-push landings jump the machine gate line and show in resources [Q1,Q2]"],
];

/**
 * The first string literal after each top-level `test(`, unescaped; a quote style or a stable-ID prefix does not change the title.
 *
 * @param {string} source
 * @returns {string[]}
 */
function titles(source) {
  return source.split(/\n {0,2}test\(/u).slice(1).flatMap(rest => {
    const literal = /^(["'`])((?:\\.|(?!\1)[^\\])*)\1/u.exec(rest);
    return literal ? [literal[2].replace(/\\(.)/gu, '$1')] : [];
  });
}

/**
 * How many times a file declares a case with this title, with or without one stable-ID prefix.
 *
 * @param {string} name
 * @param {string} _quote Kept so each case lists its original quote style; the title is read unescaped.
 * @param {string} caseTitle
 * @returns {number}
 */
function declarations(name, _quote, caseTitle) {
  const source = readFileSync(join(import.meta.dirname, '../../..', name), 'utf8');
  return titles(source).filter(title => title === caseTitle || (title.endsWith(`: ${caseTitle}`) && /^[a-z0-9.-]+$/u.test(title.slice(0, -caseTitle.length - 2)))).length;
}

test('cli.cases.the-three-e2e-files-hold-every-case: clause 1: the three e2e files hold every case the single e2e.test.js held, so none was dropped to get under two minutes [C7]', () => {
  for (const [quote, caseTitle] of CASES) {
    const found = FILES.map(name => declarations(name, quote, caseTitle));
    assert.equal(found.reduce((sum, count) => sum + count, 0), 1, `${caseTitle}: declared once across ${FILES.join(', ')}`);
  }
  assert.equal(CASES.length, 12, 'the original e2e.test.js held thirteen cases; #11202 deleted one, so twelve remain');
  assert.ok(FILES.every(name => CASES.some(([quote, caseTitle]) => declarations(name, quote, caseTitle) > 0)), 'every split file keeps at least one case');
});
