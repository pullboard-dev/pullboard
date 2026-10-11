/** Cockpit items checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addItem, closeBoard, completeCheckBaseline, openBoard } from '../../src/board.js';
import { tapTarget, SPEC, machine, project, build, sendBack, startView, element, target, openPage, agentEntries, accept, itemRow, boardOf, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, settled } from './fixture.js';


test('wait references stay on one line and link to every prerequisite at phone and desktop widths [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for prerequisite layout checks.');
  const box = machine();
  const demo = project(box, 'waits-demo');
  box.run(demo.repo, 'add', 'web', 'Prerequisite one', '--specs', 'G1', '--criterion', 'finish first');
  box.run(demo.repo, 'add', 'web', 'Prerequisite two', '--specs', 'G1', '--criterion', 'finish second');
  box.run(demo.repo, 'add', 'web', 'Blocked item', '--specs', 'G1', '--criterion', 'wait on both', '--after', '1,2');
  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'waits-chrome'));
    /** Pick a visible click target only after scrolling and its hit-test position have settled. */
    const click = async (selector) => {
      const point = JSON.parse(await chrome.evaluate(`(async () => {
        const element=document.querySelector(${JSON.stringify(selector)});
        if (!element) throw Error('missing '+${JSON.stringify(selector)});
        const visible=()=>{const style=getComputedStyle(element),rect=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0&&!element.closest('[hidden]');};
        if(!visible())throw Error('target is not visible: '+${JSON.stringify(selector)});
        element.scrollIntoView({block:'center'});
        const point=()=>{const currentElement=document.querySelector(${JSON.stringify(selector)});if(!currentElement)return null;const style=getComputedStyle(currentElement),rect=currentElement.getBoundingClientRect();if(style.display==='none'||style.visibility==='hidden'||rect.width<=0||rect.height<=0||currentElement.closest('[hidden]'))return null;const x=rect.x+rect.width/2,y=rect.y+rect.height/2,hit=document.elementFromPoint(x,y);return {x,y,scrollX,scrollY,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},hit:!!hit&&(hit===currentElement||currentElement.contains(hit))};};
        const targets=[window,document,...(()=>{const nodes=[];for(let node=element.parentElement;node;node=node.parentElement)if(node.scrollHeight>node.clientHeight||node.scrollWidth>node.clientWidth)nodes.push(node);return nodes;})()];
        let scrolled=false,scrollEnded=false;
        const onScroll=()=>{scrolled=true;};
        const onScrollEnd=()=>{scrollEnded=true;};
        targets.forEach(target=>{target.addEventListener('scroll',onScroll,{passive:true});target.addEventListener('scrollend',onScrollEnd);});
        try {
          return JSON.stringify(await new Promise((resolve,reject)=>{
            let previous=null,stable=0,frameId=0,finished=false;
            const timeout=setTimeout(()=>{finished=true;cancelAnimationFrame(frameId);reject(Error('scroll did not settle for '+${JSON.stringify(selector)}+': '+JSON.stringify(previous)));},5000);
            const frame=()=>{
              if(finished)return;
              const current=point();
              if(!current){previous=null;stable=0;frameId=requestAnimationFrame(frame);return;}
              const same=previous&&Math.abs(current.scrollX-previous.scrollX)<=.1&&Math.abs(current.scrollY-previous.scrollY)<=.1&&Math.abs(current.rect.x-previous.rect.x)<=.1&&Math.abs(current.rect.y-previous.rect.y)<=.1&&Math.abs(current.rect.width-previous.rect.width)<=.1&&Math.abs(current.rect.height-previous.rect.height)<=.1;
              stable=same?stable+1:0;previous=current;
              if(stable>=3&&current.hit&&(!scrolled||scrollEnded||stable>=12)){finished=true;clearTimeout(timeout);resolve(current);return;}
              frameId=requestAnimationFrame(frame);
            };
            frameId=requestAnimationFrame(frame);
          }));
        } finally { targets.forEach(target=>{target.removeEventListener('scroll',onScroll);target.removeEventListener('scrollend',onScrollEnd);}); }
      })()`));
      const deadline = Date.now() + 5000;
      let ready;
      let settled = false;
      while (Date.now() < deadline) {
        ready = JSON.parse(await chrome.evaluate(`(async()=>{
          const sample=()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;const style=getComputedStyle(element),rect=element.getBoundingClientRect();if(style.display==='none'||style.visibility==='hidden'||rect.width<=0||rect.height<=0||element.closest('[hidden]'))return null;const x=rect.x+rect.width/2,y=rect.y+rect.height/2,hit=document.elementFromPoint(x,y);return {x,y,scrollX,scrollY,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},hit:!!hit&&(hit===element||element.contains(hit))};};
          let previous=null,stable=0,current=null,frameId=0,finished=false;
          await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{finished=true;cancelAnimationFrame(frameId);reject(Error('pointer target did not stabilize for '+${JSON.stringify(selector)}));},1500);const frame=()=>{if(finished)return;current=sample();const same=current&&previous&&Math.abs(current.scrollX-previous.scrollX)<=.1&&Math.abs(current.scrollY-previous.scrollY)<=.1&&Math.abs(current.rect.x-previous.rect.x)<=.1&&Math.abs(current.rect.y-previous.rect.y)<=.1&&Math.abs(current.rect.width-previous.rect.width)<=.1&&Math.abs(current.rect.height-previous.rect.height)<=.1;stable=same?stable+1:0;previous=current;if(stable>=2&&current.hit){finished=true;clearTimeout(timeout);resolve();}else frameId=requestAnimationFrame(frame);};frameId=requestAnimationFrame(frame);});
          return JSON.stringify(current);
        })()`));
        await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ready.x, y: ready.y });
        const underPointer = JSON.parse(await chrome.evaluate(`(async()=>{
          const sample=()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;const rect=element.getBoundingClientRect(),hit=document.elementFromPoint(${ready.x},${ready.y});return {scrollX,scrollY,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},hit:!!hit&&(hit===element||element.contains(hit))};};
          let previous=null,stable=0,current=null,frameId=0,finished=false;
          await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{finished=true;cancelAnimationFrame(frameId);reject(Error('pointer target did not stabilize for '+${JSON.stringify(selector)}));},1000);const frame=()=>{if(finished)return;current=sample();const same=current&&previous&&Math.abs(current.scrollX-previous.scrollX)<=.1&&Math.abs(current.scrollY-previous.scrollY)<=.1&&Math.abs(current.rect.x-previous.rect.x)<=.1&&Math.abs(current.rect.y-previous.rect.y)<=.1&&Math.abs(current.rect.width-previous.rect.width)<=.1&&Math.abs(current.rect.height-previous.rect.height)<=.1;stable=same?stable+1:0;previous=current;if(stable>=2&&current.hit){finished=true;clearTimeout(timeout);resolve();}else frameId=requestAnimationFrame(frame);};frameId=requestAnimationFrame(frame);});return JSON.stringify({current,stable});
        })()`));
        if (underPointer?.current?.hit && underPointer.stable >= 2 && Math.abs(underPointer.current.scrollX-ready.scrollX)<=.1 && Math.abs(underPointer.current.scrollY-ready.scrollY)<=.1 && Math.abs(underPointer.current.rect.x-ready.rect.x)<=.1 && Math.abs(underPointer.current.rect.y-ready.rect.y)<=.1 && Math.abs(underPointer.current.rect.width-ready.rect.width)<=.1 && Math.abs(underPointer.current.rect.height-ready.rect.height)<=.1) {
          point.x = ready.x;
          point.y = ready.y;
          point.scrollX = ready.scrollX;
          point.scrollY = ready.scrollY;
          point.rect = ready.rect;
          settled = true;
          break;
        }
      }
      assert.ok(settled && ready && point.x === ready.x && point.y === ready.y,
        `${selector}: scroll and target geometry settle under the pointer before press: ${JSON.stringify({ point, ready })}`);
      await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    };
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.querySelector('#chain [data-item="3"] .meta .gate')?.getBoundingClientRect().width > 0`);
      await click('#chain [data-item="1"] .t');
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Prerequisite one')");
      const itemIds = await chrome.evaluate('data.project.items.map(item => item.id + ":" + item.title + ":" + item.blockedBy.join(","))');
      assert.ok(await chrome.evaluate('!!document.querySelector(\'#chain [data-item="3"]\')'), `${width}: blocked item appears among ${itemIds.join('; ')}`);
      const list = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
        const gate=document.querySelector('#chain [data-item="3"] .meta .gate');
        const lineHeight=e=>parseFloat(getComputedStyle(e).lineHeight);
        const neighbors=[...gate.parentElement.children].filter(e=>e!==gate).map(lineHeight).filter(Number.isFinite);
        const units=[...gate.querySelectorAll('.wait-unit')];
        return {height:gate.getBoundingClientRect().height,neighborHeight:Math.max(...neighbors),unitWhiteSpaces:units.map(unit=>getComputedStyle(unit).whiteSpace),unitY:units.map(unit=>unit.getBoundingClientRect().y),links:[...gate.querySelectorAll('button.ref')].map(link=>link.dataset.go)};
      })())`));
      t.diagnostic(`${width}px list wait marker: ${list.height}px tall, neighboring metadata line ${list.neighborHeight}px`);
      assert.ok(list.height <= list.neighborHeight + 1, `${width}: list reference matches neighboring metadata height: ${JSON.stringify(list)}`);
      assert.deepEqual(list.unitWhiteSpaces, ['nowrap', 'nowrap'], `${width}: each list prerequisite stays intact`);
      assert.equal(new Set(list.unitY).size, 1, `${width}: both list prerequisites fit on one line: ${JSON.stringify(list)}`);
      assert.deepEqual(list.links, ['item:1', 'item:2'], `${width}: every prerequisite is a link`);

      await click('#chain [data-item="3"] .t');
      await chrome.waitFor("!!document.querySelector('#detail .kv dd.waits-on')");
      const detail = JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
        const waits=document.querySelector('#detail .kv dd.waits-on');
        const units=[...waits.querySelectorAll('.wait-unit')];
        return {height:waits.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(waits).lineHeight),unitWhiteSpaces:units.map(unit=>getComputedStyle(unit).whiteSpace),unitY:units.map(unit=>unit.getBoundingClientRect().y),
          links:[...waits.querySelectorAll('button.ref')].map(link=>link.dataset.go)};
      })())`));
      t.diagnostic(`${width}px detail wait marker: ${detail.height}px tall, neighboring metadata line ${detail.lineHeight}px`);
      assert.ok(detail.height <= detail.lineHeight + 1, `${width}: detail prerequisite line matches its metadata: ${JSON.stringify(detail)}`);
      assert.deepEqual(detail.unitWhiteSpaces, ['nowrap', 'nowrap'], `${width}: each detail prerequisite stays intact`);
      assert.deepEqual(detail.links, ['item:1', 'item:2'], `${width}: detail links every prerequisite`);
      assert.equal(new Set(detail.unitY).size, 1, `${width}: detail links share one line: ${JSON.stringify(detail)}`);
      t.diagnostic(`${width}px detail wait links share y=${detail.unitY[0]}`);
      for (const [id, title] of [['1', 'Prerequisite one'], ['2', 'Prerequisite two']]) {
        await click('#chain [data-item="3"] .t');
        await chrome.waitFor("!!document.querySelector('#detail .kv dd.waits-on')");
        await click(`#detail .waits-on [data-go="item:${id}"]`);
        await chrome.waitFor(`document.querySelector('#detail h2').textContent.includes(${JSON.stringify(title)})`);
      }
    }
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught page exceptions');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});
