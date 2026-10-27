/** Real typed queue mutations preserve the exhaustive native/relay reader oracle [N26,H16]. */
import assert from 'node:assert/strict';

/** Record genuine request and action events before a bound batch answer; no typed request executes the action. */
export async function seedTypedRequests({board,box,store,exercise,agent}) {
  const item=store.addItem(board,{by:'coordinator',lane:box.lane,title:'Typed request parity',criterion:'Actual queued requests retain their native answer binding'});
  const id=await exercise('fileTypedRequest',()=>store.fileTypedRequest(board,{agentId:agent,verb:'hold',itemId:item,cause:'routing-assignment',note:'Real private parity queue entry'}));
  assert.ok(Number.isSafeInteger(id),'request must really be filed, not refused setup');
  assert.equal(Boolean(store.getItem(board,item).item_hold_reason),false,'filing never applies the requested mutation');
  store.holdItem(board,item,{agentId:'coordinator',reason:'Actual coordinator action for parity'});
  const eventId=store.events(board).findLast(event=>event.event_kind==='hold_item'&&event.item_id===item&&event.event_by==='coordinator').event_id;
  const answers=await exercise('answerTypedRequests',()=>store.answerTypedRequests(board,{agentId:'coordinator',answers:[{requestId:id,outcome:'done',eventId,note:'Bound to actual native action'}]}));
  assert.equal(answers?.[0]?.status,'done');
  assert.equal(answers[0].answer.eventId,eventId);
  assert.equal(answers[0].requester,agent);
}
