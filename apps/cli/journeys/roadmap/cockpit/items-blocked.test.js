// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit roadmap blocked rows: dot, expansion, prose and the phone remote blocker [N26]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixtureMachineSettings } from '../../../tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../../tests/fixtures/testkit.js';
import {
  machine,
  project,
  startView,
  chromeExecutable,
  closeSnapshotChrome,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';
import { openRoadmapChrome } from '../../../tests/fixtures/cockpit/roadmap.js';

/**
 * A machine whose gate settings pin controller dispatch: build() submits here and expects the gate held in the
 * submitting process, but with pull as the default (#6182-#6185) submit only queues a job and the item stays claimed.
 */
function pinnedMachine() {
  const box = machine();
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'controller' } });
  return box;
}

/**
 * web-1 builds an item as the shared build() does, claiming and submitting through this process: the Git work and its
 * hooks stay real processes, and the two board commands no longer start a Node each, which this journey's setup
 * paid for a hundred times.
 */
async function build(box, p, id, file) {
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
  await box.inProcess(p.web, 'submit', String(id), '--no-next');
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
async function blockedRoadmap(t, stage) {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the roadmap blocker check.');
  const box = pinnedMachine(), alpha = project(box, 'blocked-roadmap');
  await box.inProcess(alpha.repo, 'add', 'web', 'Base work', '--specs', 'G1', '--criterion', 'Base is ready.');
  await box.inProcess(alpha.repo, 'add', 'web', 'Waits on base', '--specs', 'G1', '--criterion', 'Use #1 and #3 <em>literally</em>. More detail stays in Items.', '--after', '1');
  await box.inProcess(alpha.repo, 'add', 'web', 'Free work', '--specs', 'G1', '--criterion', 'Ready.');
  await box.inProcess(alpha.repo, 'add', 'web', 'Sent back once', '--specs', 'G1', '--criterion', 'Ready.');
  await build(box, alpha, 4, 'sent-back.html'); await sendBack(box, alpha, 4, 'The heading is missing.');
  await box.inProcess(alpha.repo, 'edit', '4', '--after', '1', '--reason', 'Waits on the base.');
  await box.inProcess(alpha.repo, 'add', 'web', 'Landed work', '--specs', 'G1', '--criterion', 'The page renders.');
  await build(box, alpha, 5, 'landed.html'); await accept(box, alpha, 5);
  box.git(alpha.repo, '-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', '--no-edit', alpha.itemBranches.get(`${alpha.baseBranch}:5`));
  await box.inProcess(alpha.repo, 'merged', '5', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  await box.inProcess(alpha.repo, 'add', 'web', 'Building work', '--specs', 'G1', '--criterion', 'The corrected page renders.');
  await build(box, alpha, 6, 'building.html'); await sendBack(box, alpha, 6, 'See #1 and #3 before accepting.\nMore detail stays in Items.');
  await box.inProcess(alpha.web, 'claim', '6');
  const second = join(box.dir, 'second-builder');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/second');
  joinFixtureSeat(box, second, 'web'); await box.inProcess(second, 'claim', '1');
  const other = project(box, 'blocked-roadmap-other');
  await box.inProcess(other.repo, 'add', 'web', 'Remote base', '--specs', 'G1', '--criterion', 'Ready.');
  await box.inProcess(other.repo, 'add', 'web', 'Remote sent-back work', '--specs', 'G1', '--criterion', 'Remote renders.');
  await build(box, other, 2, 'remote.html'); await sendBack(box, other, 2, 'Remote latest finding\nMore detail stays in Items');
  await box.inProcess(other.repo, 'edit', '2', '--after', '1', '--reason', 'Waits on remote base.');
  await box.inProcess(other.repo, 'hold', 'web', '--reason', 'Review the remote dependency');
  await box.inProcess(alpha.repo, 'milestone', 'add', 'Next', '--reason', 'Arrange fixture release', '--items', '1,2,3,4,5,6,blocked-roadmap-other#2');
  stage('setup-end');
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-blocked-roadmap-chrome-'));
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

test('a blocked roadmap item shows its dot and expands to say why [N26]', { timeout: 90_000 }, async (t) => {
  const began = performance.now();
  /** Name each stage boundary and its elapsed time, so a slow run reads as a diagnosis. */
  const stage = phase => console.log('roadmap-blocked-stage ' + JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - began) }));
  const { chrome, row, opened, reads, address, close } = await blockedRoadmap(t, stage);
  try {
    stage('first-open');
    const blocked = await opened('#2');
    assert.match(blocked, /CriterionUse #1 and #3 <em>literally<\/em>\./u, 'the approved dense detail leads with the criterion');
    assert.doesNotMatch(blocked, /More detail stays in Items/u, 'only the first criterion sentence is shown');
    assert.deepEqual(JSON.parse(await chrome.stable(`JSON.stringify([...${row('#2')}.parentElement.querySelectorAll('.roadmap-criterion .roadmap-ref')].map(chip=>chip.textContent))`)), [], 'references inside Criterion stay plain text');
    assert.equal(await chrome.stable(`${row('#2')}.parentElement.querySelectorAll('.roadmap-criterion em').length`),0,'criterion markup stays escaped');
    assert.match(blocked, /Waits on#1 building.*web-2.*since/u, 'dependency includes state, holder and local time');
    assert.match(blocked, /History.*added/u); assert.match(blocked, /Release.*Next.*G1/u);
    // The other board also has an item #2, so only this board's reads count.
    const local = await chrome.stable('boardPath(view.root)');
    assert.ok((await reads()).filter(url => url.endsWith(local + '/items/2')).length <= 1, 'the first opened row reads its detail once, ahead or on expand');
    stage('rows-open');
    for (const id of ['#2', '#6', '#5']) {
      if (id !== '#2') await opened(id);
      const text = await chrome.stable(`${row(id)}.parentElement.querySelector('.milestone-why').textContent`);
      if (id === '#6') {
        assert.match(text, /Agents.*web-1.*building/u); assert.match(text, /Sent back.*coordinator.*See #1 and #3 before accepting/u);
        assert.match(text, /History.*claimed.*submitted.*sent back.*claimed again/u);
      }
      if (id === '#5') { assert.match(text, /Agents.*web-1.*built.*coordinator.*verified/u); assert.match(text, /History.*accepted.*landed/u); }
      const before = await reads();
      await press(chrome, row(id));
      await chrome.stable(`${row(id)}.focus();true`);
      await chrome.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13 });
      await chrome.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13 });
      await chrome.waitFor(`${row(id)}.getAttribute('aria-expanded')==='true'`);
      assert.deepEqual(await reads(), before, 'reopening keeps the shared item-detail cache');
      assert.equal(await chrome.stable('location.href'), address); assert.equal(await chrome.stable('view.tab'), 'roadmap');
      await press(chrome, row(id));
    }
    const base = await opened('#1');
    assert.match(base, /Blocks.*#2 unclaimed/u, 'the dense row names its open dependants');
    assert.match(base, /Blocks.*#4 sent back/u, 'a sent-back dependant keeps its status');
    assert.equal(await chrome.stable(`${row('#1')}.parentElement.querySelectorAll('.milestone-why a').length`), 1, 'references are chips; only the explicit Items link navigates');
    await press(chrome, row('#1'));
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setEmulatedMedia', { features:[{name:'prefers-color-scheme',value:scheme}] });
      await opened('#6');
      const style = JSON.parse(await chrome.stable(`JSON.stringify((()=>{const panel=${row('#6')}.parentElement.querySelector('.milestone-why');const label=panel.querySelector('dt'),value=label.nextElementSibling;return {icons:panel.querySelectorAll('dt svg').length, labels:panel.querySelectorAll('dt').length,top:getComputedStyle(label).alignSelf,chip:getComputedStyle(panel.querySelector('.roadmap-step.no')).backgroundColor,danger:getComputedStyle(panel.querySelector('.roadmap-return')).backgroundColor,labelTop:label.getBoundingClientRect().top,valueTop:value.getBoundingClientRect().top};})())`));
      assert.equal(style.icons, style.labels, `${scheme}: every label has an inline icon`);
      assert.equal(style.top, 'start', `${scheme}: labels stay at the first value line`);
      assert.ok(Math.abs(style.labelTop-style.valueTop)<2, `${scheme}: wrapped values keep their top-aligned label`);
      assert.notEqual(style.danger, 'rgba(0, 0, 0, 0)', `${scheme}: send-back reason is tinted`);
      const colors = JSON.parse(await chrome.stable(`JSON.stringify((()=>{const panel=${row('#6')}.parentElement.querySelector('.milestone-why');const probe=document.createElement('span');panel.append(probe);probe.style.color='var(--mark-back)';const danger=getComputedStyle(probe).color;probe.style.color='color-mix(in oklab, var(--mark-back) 60%, var(--ink))';const callout=getComputedStyle(probe).color;probe.style.color='var(--stage-merged)';const success=getComputedStyle(probe).color;probe.remove();return {danger,callout,success,reject:getComputedStyle(panel.querySelector('.roadmap-step.no')).backgroundColor,reason:getComputedStyle(panel.querySelector('.roadmap-return')).color};})())`));
      assert.equal(colors.reject, colors.danger, `${scheme}: send-back history uses the back-edge token (--mark-back, as the stylesheet and colors.test.js ship it)`);
      assert.equal(colors.reason, colors.callout, `${scheme}: the callout reads the back-edge token mixed toward the ink, as .chip.no does`);
      await press(chrome, row('#6'));
      await opened('#5');
      const landed = JSON.parse(await chrome.stable(`JSON.stringify((()=>{const r=${row('#5')},panel=r.parentElement.querySelector('.milestone-why');return {color:getComputedStyle(panel.querySelector('.roadmap-event:last-child .roadmap-step')).backgroundColor,stage:r.querySelector('.stage-word')?.textContent,icon:!!r.querySelector('.roadmap-landed svg')};})())`));
      assert.equal(landed.color, colors.success, `${scheme}: landing history uses the merged-stage token (--stage-merged)`);
      assert.equal(landed.stage, 'Landed'); assert.equal(landed.icon, false, 'a landed row reads Landed, with no checkmark');
      await press(chrome, row('#5'));
    }
    assert.deepEqual(chrome.exceptions, []);
  } finally { await close(); }
});

test('a blocked roadmap item reads its prose plainly and its remote blocker on a phone [N26]', { timeout: 90_000 }, async (t) => {
  const began = performance.now();
  /** Name each stage boundary and its elapsed time, so a slow run reads as a diagnosis. */
  const stage = phase => console.log('roadmap-remote-stage ' + JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - began) }));
  const { chrome, row, opened, reads, address, close } = await blockedRoadmap(t, stage);
  try {
    for (const width of [375,1280]) for (const scheme of ['light','dark']) {
      await chrome.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      await chrome.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:scheme}]});
      for (const [id,field] of [['#2','.roadmap-criterion'],['#6','.roadmap-return']]) {
        await opened(id);
        const prose=JSON.parse(await chrome.stable(`JSON.stringify((()=>{const panel=${row(id)}.parentElement.querySelector('.milestone-why'),value=panel.querySelector(${JSON.stringify(field)});return {text:value.textContent,chips:value.querySelectorAll('.roadmap-ref').length,links:panel.querySelectorAll('a').length};})())`));
        assert.match(prose.text,/#1 and #3/u,`${width}/${scheme}: ${field} keeps its literal references`);
        assert.equal(prose.chips,0,'the clarified bar keeps prose references plain');assert.equal(prose.links,1,'only Open in Items is a link');
        assert.equal(await chrome.stable('location.href'),address);assert.equal(await chrome.stable('view.tab'),'roadmap');
        await press(chrome,row(id));
      }
    }
    await chrome.send('Emulation.setDeviceMetricsOverride', {width:375,height:900,deviceScaleFactor:1,mobile:false});
    const remote = await opened('blocked-roadmap-other#2');
    assert.match(remote, /Waits on#1 unclaimed/u); assert.match(remote, /Review the remote dependency/u);
    assert.match(remote, /Sent back.*Remote latest finding/u); assert.doesNotMatch(remote, /More detail stays in Items/u);
    const metrics = JSON.parse(await chrome.stable(`JSON.stringify((()=>{const r=${row('blocked-roadmap-other#2')},d=r.querySelector('.roadmap-after').getBoundingClientRect(),t=r.querySelector('.t').getBoundingClientRect();return {visible:d.width>0&&d.left>=t.left&&d.right<=t.right,after:[d.left,d.right,d.width],title:[t.left,t.right],columns:getComputedStyle(r).gridTemplateColumns,children:[...r.children].map(k=>[String(k.className).slice(0,30),Math.round(k.getBoundingClientRect().width)]),row:r.getBoundingClientRect().width,text:r.querySelector('.t').textContent,width:document.documentElement.scrollWidth,viewport:innerWidth};})())`));
    assert.ok(metrics.visible, `the remote blocker mark stays visible on a phone: ${JSON.stringify(metrics)}`); assert.ok(metrics.width<=metrics.viewport);
    await press(chrome, `${row('blocked-roadmap-other#2')}.parentElement.querySelector('.milestone-why a[data-go]')`);
    await chrome.waitFor("view.tab==='items' && document.querySelector('#detail h2')?.textContent.includes('Remote sent-back work')");
    assert.equal(await chrome.stable("document.querySelector('#proj-name').textContent"), 'blocked-roadmap-other');
    assert.deepEqual(chrome.exceptions, []);
  } finally { await close(); }
});
