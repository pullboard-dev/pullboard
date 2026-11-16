/** Shared setup for the doctrine check-rule journeys: a project with one counted check rule, a claimed web item, and a pulled submit [D1,D3,C7]. */
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fixtureAdd } from './testkit.js';
import { settleSubmit } from './submit/settle.js';

export const RULE = '- Q1 [approved, must] Web pages carry no TODO markers. | gate: check grep -rn TODO web';

/**
 * Bind the check-rule helpers to one file's e2e helpers, so each journey file keeps its own cleanup.
 */
export function createCheckedHelpers({ project }) {
  /**
   * A project whose doctrine has one check rule with the given trailing fields, two problems on
   * main, a web worktree that carries main, and a claimed web item.
   */
  async function checkedProject(fields, extraRows = []) {
    const box = project();
    appendFileSync(join(box.repo, 'DOCTRINE.md'), `\n## Q · Quality\n${[`${RULE} | ${fields}`, ...extraRows].join('\n')}\n`);
    mkdirSync(join(box.repo, 'web'));
    writeFileSync(join(box.repo, 'web', 'a.html'), 'TODO one\nTODO two\n');
    writeFileSync(join(box.repo, 'web', 'keep.txt'), 'keep\n');
    box.git(box.repo, 'add', '-A');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: add the quality doctrine');
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    assert.equal((await fixtureAdd(box.inProcess, box.repo, 'web', 'Page', '--specs', 'G1')).code, 0);
    assert.equal((await box.inProcess(box.web, 'claim', '1')).code, 0);
    return box;
  }

  /** Write web files in the worktree and commit them through its hooks. */
  function commitWeb(box, files, message) {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(box.web, 'web', name), text);
    box.git(box.web, 'add', '-A');
    const committed = box.tryGit(box.web, 'commit', '-q', '-m', message);
    assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}`);
  }

  /** Submit from a worktree and wait for the pulled gate's receipt; the refusals and notes a red or green gate reports are under gate.analysis [P7,C7]. */
  async function settled(t, box, web, id) {
    const sent = await box.inProcess(web, 'submit', String(id), '--json');
    assert.equal(sent.code, 0, sent.err + sent.out);
    return settleSubmit(t, box, JSON.parse(sent.out));
  }
  return { RULE, checkedProject, commitWeb, settled };
}
