/** Moves during pairing: a device joins after a move, and a move made while pairing is refused or discarded [H15,H17,H16]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

test('cli.journeys-relay-pairing-moves.pairing-again-after-a-device-joined: pairing again after a device joined and a move was added succeeds [H15,H17,H16]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const first = await box.cliLocal('relay', 'pair');
  assert.equal(first.code, 0, 'the unchanged linked board can issue a pairing package');
  const joined = await box.otherDeviceJoin(first.document.code);
  assert.equal(joined.joined.board, box.before.tables.board_meta.find(row => row.meta_key === 'board_id').meta_value,
    'the baseline one-use package is consumed by a genuine second private native device');
  const added = await box.cliLocal('add', box.lane, 'An acknowledged move before pairing', '--criterion', 'The next device can join');
  assert.equal(added.code, 0, JSON.stringify(added.document));
  const snapshot = await box.cliLocal('export');
  assert.equal(snapshot.code, 0);
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const meta = new Map(snapshot.document.tables.board_meta.map(row => [row.meta_key, row.meta_value]));
  assert.equal(state.mode, 'ordered');
  assert.equal(state.sequence, Number(meta.get('relay_applied_sequence')), 'the real sync has acknowledged this native prefix');
  const nativeCursor = snapshot.document.tables.event.at(-1)?.event_id ?? 0;
  const second = await box.cliLocal('relay', 'pair');
  assert.equal(second.code, 0, 'an acknowledged board must pair after ordinary moves: ' + JSON.stringify({
    error: second.document.error, savedNativeCursor: state.cursor, actualNativeCursor: nativeCursor,
    relaySequence: state.sequence, appliedSequence: Number(meta.get('relay_applied_sequence')),
  }));
});

test('cli.journeys-relay-pairing-moves.a-newly-paired-device-imports-the: a newly paired device imports the acknowledged moved board [H15,H17,H16]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const added = await box.cliLocal('add', box.lane, 'The next computer sees this acknowledged move', '--criterion', 'The native checkpoint and move agree');
  assert.equal(added.code, 0);
  const current = await box.cliLocal('export');
  assert.equal(current.code, 0);
  const printed = await box.cliLocal('relay', 'pair');
  assert.equal(printed.code, 0, JSON.stringify(printed.document.error));
  const paired = await box.otherDeviceJoin(printed.document.code);
  assert.deepEqual(paired.exported, current.document, 'a real independent native join imports the complete moved checkpoint');
  assert.equal(paired.exported.tables.item.some(row => row.item_title === 'The next computer sees this acknowledged move'), true);
});


test('cli.journeys-relay-pairing-moves.a-move-made-during-pairing-is: a move made during pairing is still refused as busy [H15,H17]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const result = await box.script(`
    const store = await import(${JSON.stringify(new URL('../../../../packages/store/index.js', import.meta.url).href)});
    const { openBoard } = await import(${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)});
    const {relayPair} = await import(${JSON.stringify(new URL('../../../../packages/keys/index.js', import.meta.url).href)});
    const pairPorts = await import(${JSON.stringify(new URL('../../../../packages/link/index.js', import.meta.url).href)});
    const root = process.cwd();
    const originalFetch = globalThis.fetch;
    let injected = false;
    globalThis.fetch = async (...args) => {
      if (!injected && String(args[0]).includes('/events?after=')) {
        injected = true;
        const board = openBoard(root + '/.git/pullboard/board.sqlite');
        try { store.addItem(board, {by:'coordinator',lane:${JSON.stringify(box.lane)},title:'A real local move during pairing',criterion:'The pending pairing must refuse'}); }
        finally { store.closeBoard(board); }
      }
      return originalFetch(...args);
    };
    const sink = {isTTY:false,write(){}};
    let code = null, issued = false;
    try { await relayPair(root,{...(await import(${JSON.stringify(new URL('../../tests/fixtures/board.js', import.meta.url).href)})).apiBoardOpeners,cwd:root,stdout:sink,stderr:sink,say(){},err(){},result(){issued=true;}},{...pairPorts,openBoard}); }
    catch(error) { code=error.code; }
    finally { globalThis.fetch=originalFetch; }
    process.stdout.write(JSON.stringify({injected,code,issued}));
  `);
  assert.equal(result.code,0,result.stderr);
  assert.equal(result.document.injected,true,'the real local store move occurred while the pairing sync awaited actual HTTP');
  assert.equal(result.document.code,'PAIR_BUSY','pairing must refuse a native move during its async sync: '+JSON.stringify(result.document));
  assert.equal(result.document.issued,false,'a changed native prefix never prints a usable pairing code');
});


test('cli.journeys-relay-pairing-moves.a-local-move-during-pairing-upload: a local move during pairing upload refuses before issuing a code [H15,H17]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const result = await box.script(`
    const store = await import(${JSON.stringify(new URL('../../../../packages/store/index.js', import.meta.url).href)});
    const { openBoard } = await import(${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)});
    const {relayPair} = await import(${JSON.stringify(new URL('../../../../packages/keys/index.js', import.meta.url).href)});
    const pairPorts = await import(${JSON.stringify(new URL('../../../../packages/link/index.js', import.meta.url).href)});
    const root = process.cwd();
    const originalFetch = globalThis.fetch;
    let injected = false;
    globalThis.fetch = async (...args) => {
      if (!injected && String(args[0]).includes('/api/v1/pairings/')) {
        injected = true;
        const board = openBoard(root + '/.git/pullboard/board.sqlite');
        try { store.addItem(board, {by:'coordinator',lane:${JSON.stringify(box.lane)},title:'A real local move during pairing upload',criterion:'Pairing must retry the changed native boundary'}); }
        finally { store.closeBoard(board); }
      }
      return originalFetch(...args);
    };
    const sink = {isTTY:false,write(){}};
    let code = null, issued = false;
    try { await relayPair(root,{...(await import(${JSON.stringify(new URL('../../tests/fixtures/board.js', import.meta.url).href)})).apiBoardOpeners,cwd:root,stdout:sink,stderr:sink,say(){},err(){},result(){issued=true;}},{...pairPorts,openBoard}); }
    catch(error) { code=error.code; }
    finally { globalThis.fetch=originalFetch; }
    process.stdout.write(JSON.stringify({injected,code,issued}));
  `);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.document.injected, true, 'the actual native move occurred during pairing upload');
  assert.equal(result.document.code, 'PAIR_BUSY', 'the pairing upload must reject its changed native boundary: '+JSON.stringify(result.document));
  assert.equal(result.document.issued, false, 'a changed native boundary must not print the one-use code');
});


test('cli.journeys-relay-pairing-moves.a-refused-upload-race-discards-only: a refused upload race discards only its unprinted package [H15,H17]', async t => {
  const box=await relayClientFixture(t);
  await box.link();
  const result=await box.script(`
    const store=await import(${JSON.stringify(new URL('../../../../packages/store/index.js',import.meta.url).href)});
    const { openBoard } = await import(${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)});
    const {relayPair}=await import(${JSON.stringify(new URL('../../../../packages/keys/index.js',import.meta.url).href)});
    const pairPorts = await import(${JSON.stringify(new URL('../../../../packages/link/index.js', import.meta.url).href)});
    const root=process.cwd(), originalFetch=globalThis.fetch;
    let injected=false,published=null;
    globalThis.fetch=async (...args)=>{
      const url=String(args[0]);
      if(!injected && url.includes('/api/v1/pairings/') && !url.endsWith('/consume')) {
        injected=true;published=url;
        const board=openBoard(root+'/.git/pullboard/board.sqlite');
        try{store.addItem(board,{by:'coordinator',lane:${JSON.stringify(box.lane)},title:'Late private local move',criterion:'Discard its unpublished package'});}finally{store.closeBoard(board);}
      }
      return originalFetch(...args);
    };
    const sink={isTTY:false,write(){}};let code=null,issued=false;
    try{await relayPair(root,{...(await import(${JSON.stringify(new URL('../../tests/fixtures/board.js', import.meta.url).href)})).apiBoardOpeners,cwd:root,stdout:sink,stderr:sink,say(){},err(){},result(){issued=true;}},{...pairPorts,openBoard});}catch(error){code=error.code;}finally{globalThis.fetch=originalFetch;}
    const {readFileSync}=await import('node:fs');
    const state=JSON.parse(readFileSync(root+'/.git/pullboard/relay.json','utf8'));
    const second=await originalFetch(published+'/consume',{method:'POST',headers:{authorization:'Bearer '+state.token,'content-type':'application/json','x-pullboard-engine':${JSON.stringify(String(ENGINE_VERSION))}},body:'{}'});
    process.stdout.write(JSON.stringify({code,issued,discarded:(await second.json()).error?.code}));
  `);
  assert.equal(result.code,0,result.stderr);
  assert.deepEqual(result.document,{code:'PAIR_BUSY',issued:false,discarded:'PAIR_CODE_USED'},'the stale, unprinted package has already been consumed');
  const retried=await box.cliLocal('relay', 'pair');
  assert.equal(retried.code,0,JSON.stringify(retried.document.error));
  const joined=await box.otherDeviceJoin(retried.document.code);
  assert.ok(joined.exported.tables.item.some(row=>row.item_title==='Late private local move'),'the next fresh pairing imports the current native board');
});


test('cli.journeys-relay-pairing-moves.a-local-move-while-sealing-is: a local move while sealing is refused before the pairing upload [H15,H17]', async t => {
  const box=await relayClientFixture(t);
  await box.link();
  const result=await box.script(`
    const {webcrypto}=await import('node:crypto');
    const store=await import(${JSON.stringify(new URL('../../../../packages/store/index.js',import.meta.url).href)});
    const { openBoard } = await import(${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)});
    const {relayPair}=await import(${JSON.stringify(new URL('../../../../packages/keys/index.js',import.meta.url).href)});
    const pairPorts = await import(${JSON.stringify(new URL('../../../../packages/link/index.js', import.meta.url).href)});
    const root=process.cwd(), originalEncrypt=webcrypto.subtle.encrypt;
    let injected=false,issued=false,code=null;
    webcrypto.subtle.encrypt=async function(...args) {
      const result=await originalEncrypt.apply(this,args);
      const aad=new TextDecoder().decode(args[0].additionalData??new Uint8Array());
      if(!injected && aad.startsWith('["pullboard-pairing",')) {
        injected=true;
        const board=openBoard(root+'/.git/pullboard/board.sqlite');
        try{store.addItem(board,{by:'coordinator',lane:${JSON.stringify(box.lane)},title:'A native move while the package is sealing',criterion:'No stale package is uploaded'});}finally{store.closeBoard(board);}
      }
      return result;
    };
    const sink={isTTY:false,write(){}};
    try{await relayPair(root,{...(await import(${JSON.stringify(new URL('../../tests/fixtures/board.js', import.meta.url).href)})).apiBoardOpeners,cwd:root,stdout:sink,stderr:sink,say(){},err(){},result(){issued=true;}},{...pairPorts,openBoard});}catch(error){code=error.code;}finally{webcrypto.subtle.encrypt=originalEncrypt;}
    process.stdout.write(JSON.stringify({injected,code,issued}));
  `);
  assert.equal(result.code,0,result.stderr);
  assert.deepEqual(result.document,{injected:true,code:'PAIR_BUSY',issued:false});
  assert.equal(box.calls.some(call=>call.path.startsWith('/api/v1/pairings/')),false,'a stale package is refused before its first publish request');
});
