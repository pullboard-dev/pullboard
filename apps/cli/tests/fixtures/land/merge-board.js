/**
 * The ordinary private board the land merge journeys share: a web lane that owns docs/ and test/, a bare origin, and an
 * accepted submission per call, so each journey file fits its own time budget under pull [B3,R3,C7].
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { json } from './board.js';
import { fixtureProjectPolicy } from '../testkit.js';

/**
 * Bind the board fixtures to one e2e helper set.
 *
 * @param {ReturnType<typeof import('../e2e.js').createE2eHelpers>} e2e - The test file's helpers.
 */
export function makeMergeBoard(e2e) {
  /** Configure an ordinary private board and actual publication remote for public landing controls. */
  function boardFixture() {
    const box = e2e.project('true');
    const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
    config.lanes.web.owns.push('docs/', 'test/');
    // The board's model table determines fixture seat routes since b95e1aa538.
    config.modelTiers = [{ contains: box.env.PULLBOARD_MODEL, route: 'strong' }];
    fixtureProjectPolicy(box.repo, { config });
    mkdirSync(join(box.repo, 'docs'), { recursive: true });
    mkdirSync(join(box.repo, 'test'), { recursive: true });
    writeFileSync(join(box.repo, 'docs/api.md'), '# API\n\nEnd.\n');
    writeFileSync(join(box.repo, 'test/snapshot.json'), '{"base":true}\n');
    box.git(box.repo, 'add', '-A');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: configure mechanical landing fixture');
    const remote = join(box.dir, 'origin.git');
    box.git(box.dir, 'init', '-q', '--bare', remote);
    box.git(box.repo, 'remote', 'add', 'origin', remote);
    box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
    return { ...box, remote };
  }

  /** Obtain a genuine independently verified submission with ordinary fixture authority and immutable Git bytes. */
  function accepted(box, number, files, { verify = true } = {}) {
    const builder = join(box.dir, `builder-${number}`);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', builder, 'main');
    json(box, builder, 'join', 'web');
    const id = json(box, box.repo, 'add', 'web', `Mechanical contribution ${number}`, '--specs', 'G1',
      '--criterion', 'retain the actual contributed file contents', '--check', 'true', '--accept-green', 'fixture check keeps passing').item.item_id;
    json(box, builder, 'claim', String(id));
    for (const [path, source] of Object.entries(files)) writeFileSync(join(builder, path), source);
    box.git(builder, 'add', '-A');
    const commit = e2e.commitFile(box, builder, Object.keys(files)[0], Object.values(files)[0], `feat(web): contribution ${number} [G1]`);
    assert.equal(commit.status, 0, commit.stderr);
    const head = box.git(builder, 'rev-parse', 'HEAD');
    json(box, builder, 'submit', String(id));
    if (!verify) return id;
    box.git(box.repo, 'checkout', '-q', '--detach', head);
    try { json(box, box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'checked the private fixture contribution'); }
    finally { box.git(box.repo, 'checkout', '-q', 'main'); }
    return id;
  }

  /** A docs/api.md whose three generated tables hold the given cell, so only their tables differ between versions. */
  function generatedApi(cell) {
    return ['# API', '', ...['api-command-shapes', 'api-refusal-shapes', 'api-http-shapes'].flatMap(name =>
      [`<!-- ${name}:start -->`, `| shape |`, `| ${cell} |`, `<!-- ${name}:end -->`, '']), 'End.', ''].join('\n');
  }
  return { boardFixture, accepted, generatedApi };
}
