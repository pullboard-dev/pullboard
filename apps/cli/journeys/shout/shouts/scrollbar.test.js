// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit shouts: cards beside a classic scrollbar [N26], using the shared real-board fixtures. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  tmpdir,
} from 'node:os';
import {
  join,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  shout as shoutOnBoard,
} from '../../../../../packages/store/index.js';
import {
  SPEC,
  machine,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  earlier,
  shoutsAt,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  press as sharedPress,
} from '../../../tests/fixtures/cockpit/stable.js';
import {
  MACHINE_MODEL,
} from '../../../tests/fixtures/cockpit/machine.js';

async function openConversation(chrome, key = 'none') {
  const selector = '#feed [data-shout-thread="' + key + '"]';
  await chrome.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
  await press(chrome, `document.querySelector(${JSON.stringify(selector)})`);
  await chrome.waitFor("!!document.querySelector('#feed .conversation-heading')");
}


test('shout cards fit beside a classic scrollbar [N26]', { timeout: 120_000 }, async () => {
  assert.ok(chromeExecutable(), 'this scrollbar regression proof requires actual Chrome');
  const box = machine();
  const alpha = project(box, 'cards');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G1', '--criterion', 'says goodbye');
  box.run(alpha.web, 'claim', '1');
  const second = join(box.dir, 'cards-web-2');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/cards2');
  box.run(second, 'join', 'web');
  // A committed page at a path too long for a phone, for a code reference to name.
  const deep = 'docs/a/very/long/path/that/keeps/going/past/a/phone/screen.md';
  mkdirSync(join(alpha.repo, deep, '..'), { recursive: true });
  writeFileSync(join(alpha.repo, deep), 'Deep line one\n');
  box.git(alpha.repo, 'add', deep);
  box.git(alpha.repo, 'commit', '-q', '-m', 'docs: a deep page');
  const head = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const lines = (first, n) => [first, ...Array.from({ length: n - 1 }, (_, k) => `Line ${k + 2} of the note.`)].join('\n');
  const older = 'Started on #1 two days back.';
  const colour = lines('Which colour for the button? #99 is no item.', 8);
  const ship = 'Ship #1 today?';
  const chips = `See #1 in src/cockpit.js at ${sha}; run pullboard check --json, then \`npm test\`.`;
  const long = lines('A long note that folds.', 12);
  const mixed = 'Moved #2 along.';
  const longCommand = 'node packages/gate/src/io/run/tests.js apps/cli/journeys/relay/person/requests.test.js', longPath = 'apps/cli/journeys/relay/person/requests.test.js';
  const longerPath = 'docs/a/very/long/path/that/keeps/going/well/past/any/phone/screen/width.md';
  const longChips = `Ran \`${longCommand}\` on ${longPath} and ${longerPath} today.`;
  const sourceRefs = [`SPEC.md:1-2@${head}`, `${deep}:1@${head}`];
  const refsShout = `Check ${sourceRefs[0]} and ${sourceRefs[1]} before you merge.`;
  const blockShout = `Evidence for the page:\n${sourceRefs[0]}`;
  const twoDays = new Date(); twoDays.setDate(twoDays.getDate() - 2); twoDays.setHours(12, 0, 0, 0);
  earlier(alpha.repo, twoDays, (board) => shoutOnBoard(board, { from: 'web-1', to: 'coordinator', text: older, lanes: ['web'] }));
  earlier(alpha.repo, Date.now() - 65 * 60e3, (board) => shoutOnBoard(board, { from: 'web-2', to: 'coordinator', text: colour, decision: true, lanes: ['web'] }));
  earlier(alpha.repo, Date.now() - 125e3, (board) => shoutOnBoard(board, { from: 'web-1', to: 'coordinator', text: ship, decision: true, lanes: ['web'] }));
  const asked = JSON.parse(box.run(alpha.repo, 'decisions', '--json')).decisions.find((d) => d.shout_text === ship);
  box.run(alpha.repo, 'answer', String(asked.shout_id), 'Yes, ship it.');
  box.run(alpha.web, 'shout', 'all', 'the page loads in 80ms', '--evidence', 'receipt', '--outcome', 'measured 80ms', '--item', '1', '--commit', head);
  box.run(alpha.web, 'shout', 'all', chips);
  box.run(alpha.web, 'shout', 'all', mixed, '--evidence', 'receipt', '--outcome', 'moved', '--item', '1', '--commit', head);
  box.run(alpha.web, 'shout', 'all', longChips);
  box.run(alpha.web, 'shout', 'all', refsShout);
  box.run(alpha.web, 'shout', 'all', blockShout);
  box.run(alpha.repo, 'shout', 'person', 'Launch on Friday?', '--decision');
  box.run(alpha.web, 'shout', 'all', long);


  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-classic-scrollbar-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(chromeExecutable(), view.link.href, profile);
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.shouts?.length >= 12');
    /** Press a real mouse at an uncovered control after layout settles. */
    const press = async (selector) => {
      await sharedPress(chrome, `document.querySelector(${JSON.stringify(selector)})`);
    };
    await press('[data-tab="shouts"]');
    await chrome.waitFor('!!document.querySelector("#feed .conversation-row")');
    const threads = JSON.parse(await chrome.stable("JSON.stringify([...document.querySelectorAll('#feed .conversation-row')].map(row => row.dataset.shoutThread))"));
    const nativeIds = JSON.parse(await chrome.stable("JSON.stringify(data.project.shouts.map(row => row.shout_id).sort((a,b) => a-b))"));
    for (const font of ['monospace', '']) for (const scheme of ['light','dark']) {
      const observed = [];
      for (const thread of threads) {
      if (await chrome.stable("!!document.querySelector('#feed .conversation-heading')")) await press('#feed [data-shout-thread=""]');
      await openConversation(chrome, thread);
      // A portable fallback exercises the wider font metrics used by CI, alongside the native font.
      await chrome.stable(`document.documentElement.style.setProperty('--sans', ${JSON.stringify(font)})`);
      await shoutsAt(chrome,375,scheme);
      const gutter=await chrome.stable('innerWidth-document.documentElement.clientWidth');
      assert.ok(gutter>=0&&gutter<=30, 'the fixture measures the browser scrollbar before selecting the viewport');
      await shoutsAt(chrome,360+gutter,scheme);
      const metrics=await chrome.stable(`(() => {
        const width=document.documentElement.clientWidth;
        const edge=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width};};
        const cards=[...document.querySelectorAll('#feed .shout')];
        const contentOver=[...document.body.querySelectorAll('*')].filter(e=>e.getClientRects().length && (edge(e).right>width+0.1 || e.scrollWidth>e.clientWidth+1)).slice(0,30).map(e=>{
          const s=getComputedStyle(e);return {kind:e.id||e.className||e.tagName,...edge(e),client:e.clientWidth,scroll:e.scrollWidth,display:s.display,minWidth:s.minWidth,font:s.font,overflow:s.overflow};});
        return {width,scroll:document.documentElement.scrollWidth,body:document.body.scrollWidth,contentOver,messageIds:cards.map(card=>Number(card.dataset.shoutId)),
          headers:cards.map(card=>({box:edge(card.querySelector('header')),text:edge(card.querySelector('.text')),age:{...edge(card.querySelector('time')),whole:card.querySelector('time').scrollWidth<=card.querySelector('time').clientWidth},children:[...card.querySelector('header').children].map(e=>({kind:e.className||e.tagName,...edge(e)}))})),
          models:cards.map(card=>card.querySelector('.who').title),
          ids:cards.flatMap(card=>[...card.querySelectorAll('.who,.to')].map(id=>({id:edge(id),card:edge(card)}))),
          over:cards.flatMap(card=>[...card.querySelectorAll('header,header>*')].filter(e=>edge(e).right>width).map(e=>({kind:e.className||e.tagName,...edge(e)})))};
      })()`);
      assert.equal(metrics.width,360, scheme+': actual page content is 360px, including on classic-scrollbar Chrome');
      assert.ok(metrics.models.some(text=>text.includes(MACHINE_MODEL)), 'the regression fixture includes real API model names');
      assert.ok(metrics.scroll<=metrics.width&&metrics.body<=metrics.width, scheme+': no sideways scroll: '+JSON.stringify({width:metrics.width,scroll:metrics.scroll,body:metrics.body,over:metrics.over,contentOver:metrics.contentOver}));
      assert.ok(metrics.headers.every(h=>h.children.every(e=>e.left>=h.box.left-1&&e.right<=h.box.right+1)&&h.age.whole&&Math.abs(h.age.right-h.box.right)<=1&&h.age.bottom<=h.text.top+1),
        scheme+': each header fits one line with its complete age at the right: '+JSON.stringify(metrics.headers));
      assert.ok(metrics.ids.length>0&&metrics.ids.every(({id,card})=>id.width>0&&id.left>=card.left&&id.right<=card.right),
        scheme+': every address remains visible inside its card');
      observed.push(...metrics.messageIds);
      }
      assert.deepEqual(observed.sort((a,b)=>a-b), nativeIds, 'every native message is measured once across its real conversations');
    }
    assert.deepEqual(chrome.exceptions, [], 'the real page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, {recursive:true,force:true});
    await view.stop();
  }
});
