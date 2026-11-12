// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit roadmap checks: landed, accepted and blocked rows, using the shared real-board fixtures [N26]. */
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
import { joinFixtureSeat } from '../../../tests/fixtures/testkit.js';
import {
  SPEC,
  machine,
  project,
  startView,
  target,
  chromeExecutable,
  closeSnapshotChrome,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';
import { openRoadmapChrome } from '../../../tests/fixtures/cockpit/roadmap.js';

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
  box.git(p.web, 'commit', '-q', '-m', `feat(web): ${file} [G1]`);
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

test('the roadmap shows landed, accepted and past target [N26]', { timeout: 90_000 }, async () => {
  const began = performance.now();
  /** Name each stage boundary and its elapsed time, so a slow run reads as a diagnosis. */
  const stage = phase => console.log('roadmap-items-stage ' + JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - began) }));
  const executable = chromeExecutable(); assert.ok(executable, 'Chrome is required for the roadmap header check.');
  const box=machine(), alpha=project(box,'roadmap-truth',SPEC,{lanes:{web:{owns:['web/'],specs:['G']},ops:{owns:['ops/'],specs:['G']}}});
  const names=['Landed A','Accepted A','Waiting A','Shipped B','Landed C','Accepted C','In review C','Building C','Approve the release','Held C','Withdrawn C','Landed D','Withdrawn D'];
  for(const [index,name] of names.entries()) await box.inProcess(alpha.repo,'add',index===9?'ops':'web',name,'--specs','G1','--criterion','The page renders.');
  /** Land through real Git and the ordinary board receipt; acceptance alone stays unlanded. */
  async function land(id) {
    box.git(alpha.repo,'merge','--no-ff','--no-edit',alpha.itemBranches.get(`${alpha.baseBranch}:${id}`));
    await box.inProcess(alpha.repo,'merged',String(id),box.git(alpha.repo,'rev-parse','HEAD'));
  }
  for(const id of [1,2,4,5,6]) {await build(box,alpha,id,`item-${id}.txt`);await accept(box,alpha,id);if([1,4,5].includes(id))await land(id);}
  await box.inProcess(alpha.repo,'withdraw','11','Removed from this release');
  // A release that finished, every item landed or withdrawn, without milestone ship.
  await build(box,alpha,12,'item-12.txt');await accept(box,alpha,12);await land(12);await box.inProcess(alpha.repo,'withdraw','13','Not needed after all');
  await box.inProcess(alpha.repo,'milestone','add','Finished unshipped','--reason', 'Arrange fixture release', '--items','12,13');
  await box.inProcess(alpha.repo,'milestone','add','Empty plan','--note','Nothing filed yet.');
  await build(box,alpha,7,'item-7.txt');await box.inProcess(alpha.web,'claim','8');await box.inProcess(alpha.repo,'hold','ops','--reason','Waiting for the person');
  await box.inProcess(alpha.repo,'shout','person','#9 Approve the release','--decision');
  await box.inProcess(alpha.repo,'milestone','add','Past target','--reason', 'Arrange fixture release', '--items','1,2,3');
  await box.inProcess(alpha.repo,'milestone','edit','Past target','--target',new Date(Date.now()-86_400_000).toISOString());
  await box.inProcess(alpha.repo,'milestone','add','Shipped release','--reason', 'Arrange fixture release', '--items','4');
  // Deliberately shuffle the six states; display grouping must not inherit this order.
  await box.inProcess(alpha.repo,'milestone','add','State summary','--reason', 'Arrange fixture release', '--items','10,5,9,8,7,6,11');
  await box.inProcess(alpha.repo,'milestone','ship','Shipped release','--next','State summary');
  await box.inProcess(alpha.repo,'milestone','add','Empty shipped');
  await box.inProcess(alpha.repo,'milestone','ship','Empty shipped','--next','State summary','--as','person','--reason','Arrange fixture release');
  const shipped=box.git(alpha.repo,'rev-parse','HEAD');
  const rawRoadmap=JSON.parse(await box.inProcess(alpha.repo,'roadmap','--json'));
  assert.equal(rawRoadmap.milestones.find(m=>m.name==='State summary').total,6,'649: the milestone total leaves the withdrawn member out, like the summary');
  assert.deepEqual(rawRoadmap.milestones.find(m=>m.name==='State summary').summary,{total:6,left:5,landed:1,landing:1,review:1,building:1,waiting:1,held:1,needsYou:[9],pace:{last6h:4,last2h:4,last24h:4},estimate:{low:2.5,high:7.5},window:'6h',reason:null},'real roadmap JSON owns every header field');
  stage('setup-end');
  const view=await startView(box),profile=mkdtempSync(join(tmpdir(),'pullboard-roadmap-truth-'));let chrome;
  const milestone=name=>`document.querySelector('[data-key="m:${name}"]')`;
  try {
    chrome=await openRoadmapChrome(executable,view.link.href,profile);await chrome.waitFor('data?.project?.milestones?.length===6');
    const apiSummary=JSON.parse(await chrome.stable("JSON.stringify(data.project.milestones.find(m=>m.name==='State summary').summary)"));
    assert.deepEqual(apiSummary,rawRoadmap.milestones.find(m=>m.name==='State summary').summary,'the live API carries the real CLI summary unchanged');
    await press(chrome,"document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor(`${milestone('Past target')}?.querySelector('.milestone-head')`);
    const nativeForecast=JSON.parse(await chrome.stable(`JSON.stringify({rate:${milestone('State summary')}?.querySelector('.roadmap-estimate')?.textContent||'',pace:${milestone('State summary')}?.querySelector('.roadmap-pace')?.textContent||'',completion:${milestone('State summary')}?.querySelector('.roadmap-completion')?.textContent||''})`));
    assert.equal(nativeForecast.rate,'0.7 items an hour',`the native API supplies the six-hour rate: ${JSON.stringify(nativeForecast)}`);assert.equal(nativeForecast.pace,'4 landed in the last 6 h, 4 in the last 2 h',`the native API supplies both landed counts: ${JSON.stringify(nativeForecast)}`);assert.match(nativeForecast.completion,/^done in about 5 hours, [A-Za-z]+ (?:overnight|morning|afternoon|evening|night)$/u,`the native API estimate uses the browser's weekday part of day: ${JSON.stringify(nativeForecast)}`);
    // Exercise the requested 512/700 presentation independently of the live board data above.
    await chrome.stable("(()=>{const m=data.project.milestones.find(m=>m.name==='State summary');m.count=512;m.limit=700;m.summary={...m.summary,pace:{last6h:7,last2h:7},estimate:{low:71,high:212.5}};render();return true;})()");
    const truth=await chrome.stable(`${milestone('Past target')}.textContent`);
    assert.match(truth,/1 of 3 landed/u,'acceptance does not count as landed');assert.match(truth,/past target/u);
    const states=JSON.parse(await chrome.stable(`JSON.stringify([...${milestone('Past target')}.querySelectorAll('.milestone-item')].map(row=>[row.querySelector('.id').textContent,row.querySelector('.stage-word')?.textContent]))`));
    assert.deepEqual(Object.fromEntries(states),{'#1':'Merged','#2':'Verified','#3':'Ready'});
    await press(chrome,"document.querySelector('[data-key=shipped] > .milestone-head')");
    await chrome.waitFor(`${milestone('Shipped release')}?.querySelector('.milestone-head')`);
    assert.match(await chrome.stable(`${milestone('Shipped release')}.textContent`),new RegExp(shipped.slice(0,12)),'the shipped release names its actual commit');
    assert.equal(await chrome.stable(`${milestone('Empty shipped')}.closest('.shipped')!==null`),true,'an empty shipped milestone appears only under Shipped');
    assert.equal(await chrome.stable("document.querySelectorAll('[data-key=\"m:Empty shipped\"]').length"),1,'an empty shipment is not repeated among upcoming releases');
    // Finished without milestone ship: under Shipped, no summary header, never among upcoming releases; the page opens on the
    // first release with work left (Past target), and the Releases list starts with it.
    const finished=JSON.parse(await chrome.stable(`JSON.stringify({shipped:${milestone('Finished unshipped')}?.closest('.shipped')!==null,copies:document.querySelectorAll('[data-key="m:Finished unshipped"]').length,summary:Boolean(${milestone('Finished unshipped')}?.querySelector('.roadmap-summary,.roadmap-left')),zero:/0 (left|remaining)|About 0/u.test(${milestone('Finished unshipped')}?.textContent||''),releases:[...document.querySelectorAll('#roadmap-releases [data-roadmap-jump]')].map(b=>b.querySelector('span').textContent),status:document.querySelector('[data-status=release]')?.textContent.trim()||''})`));
    assert.deepEqual([finished.shipped,finished.copies,finished.summary,finished.zero],[true,1,false,false],`a finished release sits once under Shipped with no summary: ${JSON.stringify(finished)}`);
    assert.equal(finished.releases[0],'Past target','the Releases list starts with the first release with work left');
    assert.ok(!finished.releases.includes('Finished unshipped'),'a finished release is not listed as coming');
    assert.match(finished.status,/^Past target/u,'the page opens on the first release with work left');
    // An empty plan has nothing left either: no header, its No items yet reading as before the header (tests-28, 18 Oct).
    const empty=JSON.parse(await chrome.stable(`JSON.stringify({summary:Boolean(${milestone('Empty plan')}?.querySelector('.roadmap-summary,.roadmap-left')),zero:/0 (left|remaining)|0 of 0|About 0/u.test(${milestone('Empty plan')}?.textContent||''),empty:${milestone('Empty plan')}?.querySelector('.milestone-empty')?.textContent||''})`));
    assert.deepEqual(empty,{summary:false,zero:false,empty:'No items yet.'},`an empty plan shows no header: ${JSON.stringify(empty)}`);
    stage('legend-start');
    for(const width of [320,375,1280]) {
      stage('legend-'+width);
      await chrome.send('Emulation.setDeviceMetricsOverride',{width,height:950,deviceScaleFactor:1,mobile:false});
      for(const scheme of ['light','dark']) {
        await chrome.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:scheme}]});
        const read=JSON.parse(await chrome.stable(`JSON.stringify((()=>{const m=${milestone('State summary')},bar=m.querySelector('.roadmap-summary-bar');return {text:m.textContent,releaseCount:document.querySelector('[data-roadmap-jump=\"m:State summary\"] b').textContent,legend:[...m.querySelectorAll('[data-summary-state]')].map(x=>[x.dataset.summaryState,x.querySelector('b').textContent]),legendText:[...m.querySelectorAll('[data-summary-state]')].map(x=>x.textContent.trim()),segments:[...m.querySelectorAll('[data-summary-segment]')].map(x=>[x.dataset.summarySegment,Number(x.dataset.count),x.getBoundingClientRect().width]),bar:bar?.getBoundingClientRect().width,width:document.documentElement.scrollWidth,viewport:innerWidth};})())`));
        assert.match(read.text,/5 to go.*1 of 6 landed/u);assert.doesNotMatch(read.text,/ left|5 remaining/u,'the approved count reads to go');assert.equal(read.releaseCount,'1/6','the header and Releases list share the summary total');assert.match(read.text,/1\.2 items an hour · 7 landed in the last 6 h, 7 in the last 2 h · done in about 6 days, [A-Za-z]+ (?:overnight|morning|afternoon|evening|night)/u);assert.match(read.text,/Needs you:.*#9 Approve the release/u);
        assert.deepEqual(read.legend,[['landed','1'],['landing','1'],['review','1'],['building','1'],['waiting','1'],['held','1']]);
        // The legend's words since aaeff395a3, as roadmap-summary-card.test.js reads them.
        assert.deepEqual(read.legendText,['1 landed','1 accepted, landing','1 in review','1 building','1 waiting','1 held'],`${width}/${scheme}: every label is separated from its count by actual whitespace`);assert.equal(await chrome.stable(`${milestone('State summary')}.querySelector('.milestone-limit')?.textContent||''`),'',`${width}/${scheme}: the shared release header removes the extra total-and-limit line`);
        // An entry declared inline-flex is a flex item of the legend, so Chrome reports its display as flex; card.test.js reads it the same way.
        const legendLayout=JSON.parse(await chrome.stable(`JSON.stringify([...${milestone('State summary')}.querySelectorAll('[data-summary-state]')].map(entry=>{const nodes=[...entry.children],centers=nodes.map(node=>{const r=node.getBoundingClientRect();return r.top+r.height/2;});return {display:getComputedStyle(entry).display,align:getComputedStyle(entry).alignItems,color:getComputedStyle(entry).color,weight:getComputedStyle(nodes[1]).fontWeight,tags:nodes.map(node=>node.tagName),centers,height:entry.getBoundingClientRect().height};}))`));
        assert.ok(legendLayout.every(row=>['flex','inline-flex'].includes(row.display)&&row.align==='center'&&Number(row.weight)>=600&&row.tags.join(',')==='I,B,SPAN'&&row.centers.every(center=>Math.abs(center-row.centers[0])<.75)),`${width}/${scheme}: every entry aligns its dot, bold count and label: ${JSON.stringify(legendLayout)}`);
        assert.equal(new Set(legendLayout.map(row=>row.color)).size,1,`${width}/${scheme}: the held control has the same text color as the other entries`);assert.ok(legendLayout.at(-1).height >= (width < 900 ? 44 : 32),`${width}/${scheme}: the held control keeps its ${width < 900 ? 44 : 32}px target`);
        const forecastLayout=JSON.parse(await chrome.stable(`JSON.stringify((()=>{const m=${milestone('State summary')},group=m.querySelector('.roadmap-forecast'),rate=m.querySelector('.roadmap-estimate'),pace=m.querySelector('.roadmap-pace'),completion=m.querySelector('.roadmap-completion');return {display:getComputedStyle(group).display,rate:rate.textContent,pace:pace.textContent,completion:completion.textContent,rateBold:rate.querySelectorAll('b').length,paceBold:pace.querySelectorAll('b').length};})())`));
        assert.equal(forecastLayout.display,'block',`${width}/${scheme}: the three facts stay in one flowing header line`);assert.equal(forecastLayout.rate,'1.2 items an hour');assert.equal(forecastLayout.pace,'7 landed in the last 6 h, 7 in the last 2 h');assert.match(forecastLayout.completion,/^done in about 6 days, [A-Za-z]+ (?:overnight|morning|afternoon|evening|night)$/u);assert.equal(forecastLayout.rateBold,0);assert.equal(forecastLayout.paceBold,0);
        assert.equal(read.segments.reduce((sum,row)=>sum+row[1],0),6,'the six supplied states sum to total');
        assert.ok(read.segments.every(row=>row[2]>0&&Math.abs(row[2]-read.bar/6)<1),`${width}/${scheme}: every supplied state occupies its share`);
        const overflow=read.width>read.viewport?await chrome.stable("JSON.stringify([...document.querySelectorAll('body *')].filter(e=>e.getClientRects().length&&e.getBoundingClientRect().right>innerWidth+.5).slice(0,12).map(e=>[e.tagName+'.'+String(e.className).slice(0,50),Math.round(e.getBoundingClientRect().left),Math.round(e.getBoundingClientRect().right)]))"):'';
        assert.ok(read.width<=read.viewport,`${width}/${scheme}: the header stays inside the viewport: ${read.width} > ${read.viewport}; wider than the viewport: ${overflow}`);
        const emptyPlan=JSON.parse(await chrome.stable(`JSON.stringify({summary:Boolean(${milestone('Empty plan')}?.querySelector('.roadmap-summary,.roadmap-left')),empty:${milestone('Empty plan')}?.querySelector('.milestone-empty')?.textContent||''})`));
        assert.deepEqual(emptyPlan,{summary:false,empty:'No items yet.'},`${width}/${scheme}: an empty plan shows no header, only No items yet`);
      }
    }
    const ordered = JSON.parse(await chrome.stable(`JSON.stringify([...${milestone('State summary')}.querySelectorAll('.milestone-item .id')].map(row => row.textContent))`));
    // Open work follows the backend's queue positions, whatever the shuffled membership; accepted and landed items have none and follow it (36add4ed61, f8e8ce444a, b83469ff53; milestone/order.test.js reads the same).
    assert.deepEqual(ordered, ['#7', '#8', '#9', '#10', '#6', '#5'], 'a milestone lists open work by backend queue position, then the unpositioned accepted and landed items, despite shuffled membership');
    // Equal bounds read as one number, and the legend says waiting.
    await chrome.stable("(()=>{const m=data.project.milestones.find(m=>m.name==='State summary');m.summary={...m.summary,estimate:{low:2.5,high:2.5}};render();return true;})()");
    const single=await chrome.stable(`${milestone('State summary')}.querySelector('.roadmap-completion')?.textContent||''`);
    assert.match(single,/^done in about 3 hours, /u,`equal fractional bounds round to one whole hour: ${single}`);
    // A slow day reads the 24 h window, and too few landings say so in words, each beside the landed line (#853).
    const timeLine=async()=>JSON.parse(await chrome.stable(`JSON.stringify({rate:${milestone('State summary')}.querySelector('.roadmap-estimate')?.textContent||'',pace:${milestone('State summary')}.querySelector('.roadmap-pace')?.textContent||'',completion:${milestone('State summary')}.querySelector('.roadmap-completion')?.textContent||''})`));
    await chrome.stable("(()=>{const m=data.project.milestones.find(m=>m.name==='State summary');m.summary={...m.summary,estimate:{low:6,high:6},window:'24h',reason:null};render();return true;})()");
    const daily=await timeLine();
    assert.match(daily.completion,/^done in about 6 hours, /u,`the backend's six-hour completion estimate is shared on both surfaces: ${JSON.stringify(daily)}`);
    assert.match(daily.pace,/landed in the last 6 h/u,'the landed line stays beside the 24 h estimate');
    await chrome.stable("(()=>{const m=data.project.milestones.find(m=>m.name==='State summary');m.summary={...m.summary,estimate:null,window:null,reason:'few-landings'};render();return true;})()");
    const early=await timeLine();
    assert.equal(early.completion,'too few landings yet to estimate',`few landings say so instead of inventing a completion time: ${JSON.stringify(early)}`);
    assert.match(early.pace,/landed in the last 6 h/u,'the landed line stays beside the too-early words');
    await chrome.stable("(()=>{const m=data.project.milestones.find(m=>m.name==='State summary');m.summary={...m.summary,estimate:{low:2.5,high:2.5},window:'6h',reason:null};render();return true;})()");
    assert.equal(await chrome.stable(`${milestone('State summary')}.querySelector('[data-summary-state=waiting]').textContent.trim()`),'1 waiting','the legend says waiting');
    // The API owns counts: changing held item summaries cannot change the supplied milestone summary.
    await chrome.stable("window.__originalItems=data.project.items;window.__originalRoadmapItems=data.project.milestones.find(m=>m.name==='State summary').items;data.project.items=data.project.items.map(item=>({...item,status:'open',stage:'open',merged:null,claim:null}));data.project.milestones.find(m=>m.name==='State summary').items=window.__originalRoadmapItems.map(item=>({...item,status:'open',state:'open'}));render();true");
    assert.equal(await chrome.stable(`${milestone('State summary')}.querySelector('[data-summary-state=building] b').textContent`),'1');
    await chrome.stable("data.project.items=window.__originalItems;const m=data.project.milestones.find(m=>m.name==='State summary');m.items=window.__originalRoadmapItems;m.summary.estimate=null;m.summary.pace=null;m.summary.needsYou=[];render();true");
    // A hand-edited snapshot can contain malformed counts; those values must remain inert [C5].
    await chrome.stable(`(()=>{const m=data.project.milestones.find(m=>m.name==='State summary');const value='"><img src=x onerror="window.__badRoadmapCount=true">';m.summary={...m.summary,total:value,landed:value,left:value};m.total=value;m.landed=value;render();return true})()`);
    assert.equal(await chrome.stable("document.querySelectorAll('#roadmap img,[data-status=release] img').length"),0,'malformed supplied counts never become HTML');

    assert.deepEqual(chrome.exceptions,[]);
  } finally {if(chrome)await closeSnapshotChrome(chrome);rmSync(profile,{recursive:true,force:true});await view.stop();}

});

test('a blocked roadmap item shows its dot and expands to say why [N26]', { timeout: 90_000 }, async (t) => {
  const began = performance.now();
  /** Name each stage boundary and its elapsed time, so a slow run reads as a diagnosis. */
  const stage = phase => console.log('roadmap-blocked-stage ' + JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - began) }));
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the roadmap blocker check.');
  const box = machine(), alpha = project(box, 'blocked-roadmap');
  await box.inProcess(alpha.repo, 'add', 'web', 'Base work', '--specs', 'G1', '--criterion', 'Base is ready.');
  await box.inProcess(alpha.repo, 'add', 'web', 'Waits on base', '--specs', 'G1', '--criterion', 'Use #1 and #3 <em>literally</em>. More detail stays in Items.', '--after', '1');
  await box.inProcess(alpha.repo, 'add', 'web', 'Free work', '--specs', 'G1', '--criterion', 'Ready.');
  await box.inProcess(alpha.repo, 'add', 'web', 'Sent back once', '--specs', 'G1', '--criterion', 'Ready.');
  await build(box, alpha, 4, 'sent-back.html'); await sendBack(box, alpha, 4, 'The heading is missing.');
  await box.inProcess(alpha.repo, 'edit', '4', '--after', '1', '--reason', 'Waits on the base.');
  await box.inProcess(alpha.repo, 'add', 'web', 'Landed work', '--specs', 'G1', '--criterion', 'The page renders.');
  await build(box, alpha, 5, 'landed.html'); await accept(box, alpha, 5);
  box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', alpha.itemBranches.get(`${alpha.baseBranch}:5`));
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
  let chrome;
  const row = id => `[...document.querySelectorAll('#roadmap .milestone-item')].find(x=>x.querySelector('.id')?.textContent===${JSON.stringify(id)})`;
  /** Read the visible detail only, after its optional first detail request settles. */
  async function opened(id) {
    await press(chrome, row(id));
    await chrome.waitFor(`${row(id)}?.getAttribute('aria-expanded')==='true' && !${row(id)}.parentElement.querySelector('.milestone-why[aria-busy]')`);
    return await chrome.stable(`${row(id)}.parentElement.querySelector('.milestone-why').textContent`);
  }
  /** Count item reads, excluding ordinary board polling. */
  async function reads() { return JSON.parse(await chrome.stable('JSON.stringify(window.__requests)')).filter(url => /\/items\/\d/.test(url)); }
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
    const address = await chrome.stable('location.href');
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
      assert.equal(landed.stage, 'Merged'); assert.equal(landed.icon, false, 'a landed row reads Merged, with no checkmark');
      await press(chrome, row('#5'));
    }
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
  } finally { if(chrome) await closeSnapshotChrome(chrome); rmSync(profile,{recursive:true,force:true}); await view.stop(); }
});
