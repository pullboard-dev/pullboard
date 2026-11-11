/** Private registered projects and a real Git executable that stalls only on one owned repository [C7,N33]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from './e2e.js';
import { runFixtureChild } from './child.js';
import { fixtureAdd } from './testkit.js';
import { fixtureJoin } from './testkit.js';

/** Require native setup success before reading its versioned result. */
function json(result) {
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

/** Register both real repositories before installing the stalled-Git stand-in; optional review setup uses normal moves. */
export function projectGitTimeoutFixture(t, { review = false } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.submit = { handoff: false };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'test: private foreground proof [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  let reviewer = null, item = null;
  if (review) {
    item = json(fixtureAdd(box.run, box.repo, 'web', 'Build the ready file', '--criterion', 'The ready file exists.',
      '--check', 'test -f web/ready.txt', '--wait', '--json')).item.item_id;
    json(box.run(box.web, 'claim', String(item), '--json'));
    mkdirSync(join(box.web, 'web'), { recursive: true });
    writeFileSync(join(box.web, 'web/ready.txt'), 'ready\n');
    box.git(box.web, 'add', 'web/ready.txt');
    box.git(box.web, 'commit', '-q', '-m', 'feat(web): ready file [G1]');
    json(box.run(box.web, 'submit', String(item), '--no-next', '--json'));
    reviewer = join(box.dir, 'api-reviewer');
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, box.git(box.web, 'rev-parse', 'HEAD').trim());
    json(fixtureJoin(box.run, reviewer, 'api', '--model', 'Fixture reviewer', '--route', 'strong', '--family', 'fixture-review-vendor', '--json'));
  }
  const bad = join(box.dir, 'unreachable-repository');
  mkdirSync(bad);
  box.git(bad, 'init', '-q', '-b', 'main');
  assert.equal(box.run(bad, 'init').code, 0, 'the unreachable project registers through native init');
  const located = runFixtureChild('/usr/bin/which', ['git'], { env: box.env, encoding: 'utf8' });
  assert.equal(located.status, 0, located.stderr);
  const realGit = located.stdout.trim();
  const shim = join(box.dir, 'stalled-git');
  mkdirSync(shim);
  const marker = join(box.dir, 'stalled-git-ran');
  const source = `#!/usr/bin/env node
const {appendFileSync,realpathSync}=require('node:fs');
const {spawnSync}=require('node:child_process');
const cwd=realpathSync(process.cwd()),args=process.argv.slice(2);
if(cwd===${JSON.stringify(bad)}||cwd.startsWith(${JSON.stringify(bad + '/')})) {
  appendFileSync(${JSON.stringify(marker)},String(process.pid)+'\\n');
  const owner=process.ppid;
  // budget: this deliberately stalled fixture exits if its owning CLI is terminated by the test ceiling.
  setInterval(()=>{if(process.ppid!==owner)process.exit(1);},100);
} else if(cwd===${JSON.stringify(reviewer)}&&args.includes('worktree')&&args.includes('list')) {
  // Exercise verify's registered-project fallback rather than its normal worktree listing.
  process.exit(0);
} else {
  const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});
  process.exit(result.status===null?1:result.status);
}
`;
  writeFileSync(join(shim, 'git'), source);
  chmodSync(join(shim, 'git'), 0o755);
  return { ...box, bad, marker, reviewer, item, env: { ...box.env, PATH: `${shim}:${box.env.PATH}` } };
}
