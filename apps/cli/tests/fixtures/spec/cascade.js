/** A spec project where one fact is served by a chain of two rows, drafted by one session and checked by another [C7,#9344]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crossLaneFixture } from '../e2e.js';

const AUTHOR = 'cascade-author-session';
const VERIFIER = 'cascade-verifier-session';

/**
 * Draft three rows as the author session and have the coordinator write them into SPEC.md (spec apply), then make the second serve
 * the first and the third serve the second. Returns the box with a verifier seat from an outside parent session.
 * Why serves is written by hand: spec draft has no serves flag, and the cascade follows the file's serves links.
 */
export async function cascadeBox(t) {
  const box = crossLaneFixture(t);
  const settings = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  let saved = {};
  try { saved = JSON.parse(readFileSync(settings, 'utf8')); } catch { /* A fixture with no settings file starts empty. */ }
  writeFileSync(settings, JSON.stringify({ ...saved, spec: { ...saved.spec, cascadeReject: true } }));
  const author = box.seat('cascade-author', 'web', AUTHOR);
  const ids = [];
  for (const text of ['Fact two holds.', 'Implication one follows.', 'Implication three follows.']) {
    const drafted = await box.runAsLocal(AUTHOR, author.root, 'spec', 'draft', text, '--gate', 'review', '--json');
    assert.equal(drafted.code ?? drafted.status, 0, `${drafted.out ?? drafted.stdout}${drafted.err ?? drafted.stderr}`);
    ids.push(JSON.parse(drafted.out ?? drafted.stdout).id);
  }
  const applied = await box.runLocal(box.repo, 'spec', 'apply');
  assert.equal(applied.code ?? applied.status, 0, `${applied.out ?? applied.stdout}${applied.err ?? applied.stderr}`);
  const [fact, first, third] = ids;
  const file = join(box.repo, 'SPEC.md');
  const lines = readFileSync(file, 'utf8').split('\n').map(line => {
    if (line.startsWith(`- ${first} `)) return `${line} | serves: ${fact}`;
    if (line.startsWith(`- ${third} `)) return `${line} | serves: ${first}`;
    return line;
  });
  writeFileSync(file, lines.join('\n'));
  box.git(box.repo, 'add', '-A');
  // Setup commit: the cascade is proved on the board, not by the commit hooks.
  box.git(box.repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'docs: serves chain');
  const verifier = box.seat('cascade-verifier', 'web', VERIFIER);
  return { box, author: author.agent, verifier, fact, first, third,
    verify: (id, decision, reason = 'the wording is wrong') => box.runAsLocal(VERIFIER, verifier.root, 'spec', 'verify', id, decision, '--reason', reason, '--json') };
}
