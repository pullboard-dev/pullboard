/** A phone answer authorizes exactly what the phone sent: no implied item or superseded answer it did not name [P6,B26,B29]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { relayClientFixture } from "../../tests/fixtures/relay/client.js";
import { preparePersonRequest } from "../../../../packages/person/light.js";
import {
  decodeBoardKey,
  seal,
} from "../../../../packages/kernel/index.js";
import { ENGINE_VERSION } from "../../../../packages/state/index.js";

const outboxUrl = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/outbox/index.js')).href;
const linkUrl = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/link/index.js')).href;
const storeUrl = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/store/index.js')).href;
const libUrl = pathToFileURL(resolve(import.meta.dirname, '../../../lib/index.js')).href;

/**
 * Post one genuine phone answer request through the real relay, claim it as this machine's executor,
 * then execute it with the given answer options. Returns the refusal code (or null), the result and
 * the answer each person-authored fact on the board cites. Pullboard's own executor may fulfil an
 * earlier genuine request later, so assertions count facts by the answer they cite.
 */
async function phoneAnswer(box, phone, { id, ask, args, options }) {
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const intent = preparePersonRequest({ verb: 'answer', item: ask, args }, id);
  const sealed = await seal(decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim()), new TextEncoder().encode(JSON.stringify(intent)),
    { boardId: link.board, kind: 'request', sequence: link.sequence + 1 });
  const posted = await fetch(box.origin + '/api/v1/boards/' + link.board + '/requests', { method: 'POST',
    headers: { authorization: 'Bearer ' + phone.token, 'content-type': 'application/json', 'x-pullboard-engine': String(ENGINE_VERSION) },
    body: JSON.stringify({ sequence: link.sequence + 1, sealed: Buffer.from(sealed).toString('base64url') }) });
  assert.equal(posted.status, 200, await posted.clone().text());
  const result = await box.script(`
    const {syncRelay,relayRequestDevice,relayOperation}=await import(${JSON.stringify(linkUrl)});
    const {personRequestRecords,requestIntentDigest,requestStageText}=await import(${JSON.stringify(linkUrl)});
    const store=await import(${JSON.stringify(storeUrl)});
    const {openBoard,nativeBoardPorts}=await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../../../lib/index.js')).href)});
    const {replay:replayConflictRecord,ACKNOWLEDGED_OPERATIONS,outboxQueueable,...outboxDoors}=await import(${JSON.stringify(outboxUrl)});
    const {loadConfig}=await import(${JSON.stringify(libUrl)});
    const {laneNames}=await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../../../../packages/seats/index.js')).href)});
    const root=process.cwd(), sink={isTTY:false,write(){}};
    const io={...outboxDoors,replayConflictRecord,outboxPolicy:()=>({acknowledgedOperations:ACKNOWLEDGED_OPERATIONS,outboxQueueable}),openBoard,nativeBoardPorts,cwd:root,stdout:sink,stderr:sink,say(){},err(){},onEvent(){},skipPersonRequests:true};
    await syncRelay(root,io);
    const executor=await relayRequestDevice(root);
    const read=()=>{const b=openBoard(root+'/.git/pullboard/board.sqlite');try{return personRequestRecords(b).find(r=>r.id===${JSON.stringify(id)}&&!r.duplicateOf);}finally{store.closeBoard(b);}};
    const record=read();
    if(record?.status!=='waiting'||JSON.parse(record.received).sender.kind!=='person') throw new Error('actual phone intake missing');
    const lanes=laneNames(loadConfig(root));
    const tag={id:record.id,executor,digest:requestIntentDigest(record)};
    await relayOperation(root,'shout',[{from:'person',to:'coordinator',text:requestStageText(record,'claim'),lanes}],
      {...io,personRequest:{...tag,phase:'claim'},personRequestMoveId:${JSON.stringify(id + '-claim')}});
    if(read().executor!==executor) throw new Error('actual executor claim missing');
    let refused=null,result=null;
    try{result=await relayOperation(root,'answerDecision',[${ask},{agentId:'coordinator',asPerson:true,channel:'view',lanes,...${JSON.stringify(options)}}],
      {...io,personRequest:{...tag,phase:'execute'},personRequestMoveId:${JSON.stringify(id + '-execute')}});}catch(error){refused=error.code;}
    const b=openBoard(root+'/.git/pullboard/board.sqlite');
    let personFacts;
    try{personFacts=b.db.prepare("SELECT json_extract(event_detail,'$.decision.id') AS answer FROM event WHERE event_kind='fact' AND event_by='person'").all().map(row=>row.answer);}finally{store.closeBoard(b);}
    process.stdout.write(JSON.stringify({refused,result,personFacts}));
  `);
  assert.equal(result.code, 0, result.stderr);
  return result.document;
}

/** A linked fixture board with a phone session and a person decision to answer. */
async function linkedBoard(t) {
  const box = await relayClientFixture(t);
  await box.link();
  const ask = async (text) => {
    const asked = await box.cli('shout', 'person', text, '--decision');
    assert.equal(asked.code, 0, JSON.stringify(asked.document));
    return asked.document.id;
  };
  return { box, ask, target: box.before.tables.item[0].item_id, phone: await box.phoneSession() };
}

const TEXT = 'The person approved this on the phone';

test('[P6,B26,B29] a phone answer executes with exactly the implied items it names', async (t) => {
  const { box, ask, target, phone } = await linkedBoard(t);
  const plain = await phoneAnswer(box, phone, { id: 'phone-plain', ask: await ask('Plain?'), args: { text: TEXT }, options: { text: TEXT } });
  assert.equal(plain.refused, null, `the genuine text-only answer executes: ${JSON.stringify(plain)}`);
  assert.deepEqual(plain.personFacts, [], 'a text-only answer implies nothing');
  const added = await phoneAnswer(box, phone, { id: 'phone-added', ask: await ask('Added?'), args: { text: TEXT }, options: { text: TEXT, implies: [target] } });
  assert.equal(added.refused, 'PERSON_REQUEST_RECEIPT', `an implied item the phone did not name is refused: ${JSON.stringify(added)}`);
  assert.deepEqual(added.personFacts, [], 'no person-authored fact the phone did not approve');
  const dropped = await phoneAnswer(box, phone, { id: 'phone-dropped', ask: await ask('Dropped?'), args: { text: TEXT, implies: String(target) }, options: { text: TEXT } });
  assert.equal(dropped.refused, 'PERSON_REQUEST_RECEIPT', `leaving out an item the phone named is refused: ${JSON.stringify(dropped)}`);
  assert.deepEqual(dropped.personFacts, [], 'a refused answer leaves no person fact');
  const named = await phoneAnswer(box, phone, { id: 'phone-named', ask: await ask('Named?'), args: { text: TEXT, implies: `#${target}` }, options: { text: TEXT, implies: [target] } });
  assert.equal(named.refused, null, `the item the phone named, written as the CLI takes it, executes: ${JSON.stringify(named)}`);
  assert.equal(named.personFacts.filter((answer) => answer === named.result).length, 1, `the phone-approved implication is one person fact citing its answer: ${JSON.stringify(named)}`);
});

test('[P6,B26,B31] a phone answer supersedes only the answer it names', async (t) => {
  const { box, ask, phone } = await linkedBoard(t);
  const first = await phoneAnswer(box, phone, { id: 'phone-first', ask: await ask('First?'), args: { text: TEXT }, options: { text: TEXT } });
  assert.equal(first.refused, null, JSON.stringify(first));
  const earlier = first.result;
  assert.ok(Number.isSafeInteger(earlier), `the first answer has an id: ${JSON.stringify(first)}`);
  const added = await phoneAnswer(box, phone, { id: 'phone-supersede-added', ask: await ask('Added?'), args: { text: TEXT }, options: { text: TEXT, supersedes: earlier } });
  assert.equal(added.refused, 'PERSON_REQUEST_RECEIPT', `a superseded answer the phone did not name is refused: ${JSON.stringify(added)}`);
  const named = await phoneAnswer(box, phone, { id: 'phone-supersede-named', ask: await ask('Named?'), args: { text: TEXT, supersedes: `#${earlier}` }, options: { text: TEXT, supersedes: earlier } });
  assert.equal(named.refused, null, `the answer the phone names as superseded executes: ${JSON.stringify(named)}`);
});
