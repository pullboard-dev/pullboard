/** The blocked-roadmap board shared by the blocked-row journeys: a real two-board fixture and a Chrome open on its Roadmap [N26]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { joinFixtureSeat } from '../testkit.js';
import {
  machine,
  project,
  startView,
  chromeExecutable,
  closeSnapshotChrome,
  press,
} from './harness.js';
import { openRoadmapChrome } from './roadmap.js';

/**
 * web-1 builds an item as the shared build() does, claiming and submitting through this process: the Git work and its
 * hooks stay real processes, and the two board commands no longer start a Node each, which this journey's setup
 * paid for a hundred times.
 */
async function build(box, p, id, file, { queued = false } = {}) {
  const key = `${p.baseBranch}:${id}`;
  let branch = p.itemBranches.get(key);
  if (!branch) {
    branch = `${p.baseBranch}-item-${id}`;
    box.git(p.web, 'switch', '-q', '-c', branch, p.baseBranch);
    p.itemBranches.set(key, branch);
  } else {
    box.git(p.web, 'switch', '-q', branch);
  }
  p.branch = branch;
  await box.inProcess(p.web, 'claim', String(id));
  mkdirSync(join(p.web, 'web'), { recursive: true });
  writeFileSync(join(p.web, 'web', file), `${file}\n`);
  box.git(p.web, 'add', '-A');
  // The commit-msg, pre-commit and post-commit hooks are three Node launches per commit; this journey tests the roadmap page, not the hooks.
  box.git(p.web, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', `feat(web): ${file} [G1]`);
  await (queued ? box.inProcessQueued : box.inProcess)(p.web, 'submit', String(id), '--no-next');
}

/** The coordinator accepts an item from a checkout of its submitted commit, as the shared accept() does. */
async function accept(box, p, id) {
  box.git(p.repo, 'switch', '-q', '--detach', p.itemBranches.get(`${p.baseBranch}:${id}`) ?? p.branch);
  await box.inProcess(p.repo, 'verify', String(id), 'accept', '--note', 'the page shows it', '--as', 'coordinator');
  box.git(p.repo, 'switch', '-q', 'main');
}

/** The coordinator sends an item back from a checkout of its submitted commit, as the shared sendBack() does. */
async function sendBack(box, p, id, note) {
  box.git(p.repo, 'switch', '-q', '--detach', p.itemBranches.get(`${p.baseBranch}:${id}`) ?? p.branch);
  const item = JSON.parse(await box.inProcess(p.repo, 'show', String(id), '--json'));
  const clause = JSON.parse(item.item_frozen).criterion;
  await box.inProcess(p.repo, 'verify', String(id), 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--clause', clause, '--note', note, '--as', 'coordinator');
  box.git(p.repo, 'switch', '-q', 'main');
}


/**
 * The blocked-roadmap board and a Chrome open on its Roadmap, for the cases below. One case held all of it and took
 * about 70 s of the 90 s it is given on a fast runner, so the checks that follow the setup are split in two.
 */
export async function blockedRoadmap(t, stage) {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the roadmap blocker check.');
  const box = machine(), alpha = project(box, 'blocked-roadmap');
  await box.inProcess(alpha.repo, 'add', 'web', 'Base work', '--specs', 'G1', '--criterion', 'Base is ready.');
  await box.inProcess(alpha.repo, 'add', 'web', 'Waits on base', '--specs', 'G1', '--criterion', 'Use #1 and #3 <em>literally</em>. More detail stays in Items.', '--after', '1');
  await box.inProcess(alpha.repo, 'add', 'web', 'Free work', '--specs', 'G1', '--criterion', 'Ready.');
  await box.inProcess(alpha.repo, 'add', 'web', 'Sent back once', '--specs', 'G1', '--criterion', 'Ready.');
  await box.inProcess(alpha.repo, 'add', 'web', 'Landed work', '--specs', 'G1', '--criterion', 'The page renders.');
  await box.inProcess(alpha.repo, 'add', 'web', 'Building work', '--specs', 'G1', '--criterion', 'The corrected page renders.');
  const other = project(box, 'blocked-roadmap-other');
  await box.inProcess(other.repo, 'add', 'web', 'Remote base', '--specs', 'G1', '--criterion', 'Ready.');
  await box.inProcess(other.repo, 'add', 'web', 'Remote sent-back work', '--specs', 'G1', '--criterion', 'Remote renders.');
  // The four submits queue their gates on the runner together and settle once; a gate took 7 to 20 s, one after another.
  await build(box, alpha, 4, 'sent-back.html', { queued: true });
  await build(box, alpha, 5, 'landed.html', { queued: true });
  await build(box, alpha, 6, 'building.html', { queued: true });
  await build(box, other, 2, 'remote.html', { queued: true });
  for (const [p, id] of [[alpha, 4], [alpha, 5], [alpha, 6], [other, 2]]) box.settled(p.web, id);
  await sendBack(box, alpha, 4, 'The heading is missing.');
  await box.inProcess(alpha.repo, 'edit', '4', '--after', '1', '--reason', 'Waits on the base.');
  await accept(box, alpha, 5);
  box.git(alpha.repo, '-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', '--no-edit', alpha.itemBranches.get(`${alpha.baseBranch}:5`));
  await box.inProcess(alpha.repo, 'merged', '5', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  await sendBack(box, alpha, 6, 'See #1 and #3 before accepting.\nMore detail stays in Items.');
  await box.inProcess(alpha.web, 'claim', '6');
  const second = join(box.dir, 'second-builder');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/second');
  joinFixtureSeat(box, second, 'web'); await box.inProcess(second, 'claim', '1');
  await sendBack(box, other, 2, 'Remote latest finding\nMore detail stays in Items');
  await box.inProcess(other.repo, 'edit', '2', '--after', '1', '--reason', 'Waits on remote base.');
  await box.inProcess(other.repo, 'hold', 'web', '--reason', 'Review the remote dependency');
  await box.inProcess(alpha.repo, 'milestone', 'add', 'Next', '--reason', 'Arrange fixture release', '--items', '1,2,3,4,5,6,blocked-roadmap-other#2');
  stage('setup-end');
  const view = await startView(box), profile = join(box.dir, 'blocked-roadmap-chrome');
  let chrome, address;
  const row = id => `[...document.querySelectorAll('#roadmap .milestone-item')].find(x=>x.querySelector('.id')?.textContent===${JSON.stringify(id)})`;
  /** Read the visible detail only, after its optional first detail request settles. */
  async function opened(id) {
    await press(chrome, row(id));
    await chrome.waitFor(`${row(id)}?.getAttribute('aria-expanded')==='true' && !${row(id)}.parentElement.querySelector('.milestone-why[aria-busy]')`);
    return await chrome.stable(`${row(id)}.parentElement.querySelector('.milestone-why').textContent`);
  }
  /** Count item reads, excluding ordinary board polling. */
  async function reads() { return JSON.parse(await chrome.stable('JSON.stringify(window.__requests)')).filter(url => /\/items\/\d/.test(url)); }
  /** Close the page, its profile and the view, whichever way the case ends. */
  const close = async () => { if (chrome) await closeSnapshotChrome(chrome); rmSync(profile, { recursive: true, force: true }); await view.stop(); };
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    stage('chrome-ready');
    await chrome.waitFor('data?.project?.milestones?.length===1');
    stage('state-ready');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    t.diagnostic('blocked fixture items ' + await chrome.stable("JSON.stringify(data.project.items.filter(i=>i.id<=2).map(i=>({id:i.id,status:i.status,blockedBy:i.blockedBy??null,after:i.after??null})))"));
    // Since the approved N26 Roadmap redesign (b83469ff53, #2056) a waiting row reads "after #1" beside its title.
    await chrome.waitFor(`${row('#2')}?.querySelector('.roadmap-after')`);
    assert.equal(await chrome.stable(`${row('#2')}.querySelector('.roadmap-after').textContent`), 'after #1');
    assert.equal(await chrome.stable(`${row('#2')}.querySelector('.roadmap-after a[data-go]').dataset.go`), 'item:1');
    assert.equal(await chrome.stable(`Boolean(${row('#3')}.querySelector('.roadmap-after, .block-dot'))`), false);
    await chrome.stable("window.__requests=[];window.__fetch=window.fetch;window.fetch=(url,options)=>{window.__requests.push(String(url));return window.__fetch(url,options);};true");
    address = await chrome.stable('location.href');
  } catch (error) {
    await close();
    throw error;
  }
  return { chrome, row, opened, reads, address, close };
}
