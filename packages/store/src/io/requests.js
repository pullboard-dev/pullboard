/** Typed coordinator requests are immutable queue entries, never delegated move authority [N26,B3,H16]. */
import { atomic } from "./board.js";
import { getItem as itemById } from "./board.js";
import { listAgents } from "./board.js";
import { logEvent } from "./board.js";
import { ENGINE_VERSION } from "../../../state/index.js";
import { TYPED_REQUESTS_ENGINE } from "../../../state/light.js";
import { Refused } from "../../../kernel/index.js";

export const TYPED_REQUEST_CAUSES=Object.freeze(['routing-assignment','bar-ambiguity','proof-red-tests','design-choice','conflicting-rulings','person-authority','tool-defect']);
export const TYPED_REQUEST_VERBS=Object.freeze(['reopen','hold','withdraw','reroute']);
const ROUTES=['light','mid','strong'];
/** New queue semantics never reinterpret a historical move. */
function requireEngine(board){if((board.executionEngineVersion??ENGINE_VERSION)<TYPED_REQUESTS_ENGINE)throw new Refused('ENGINE_VERSION',`typed coordinator requests require engine ${TYPED_REQUESTS_ENGINE}`);}
/** Require a concrete safe positive native identity. */
function positive(value){return Number.isSafeInteger(value)&&value>0;}
/** Validate rather than silently discard unrecognized authority-bearing fields. */
function fields(value,allowed){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));}
/** Human context is bounded data, never parsed as an executable request. */
function noteOf(note){if(note!==undefined&&typeof note!=='string')throw new Refused('BAD_TYPED_REQUEST','request note must be text');const text=(note??'').trim();if(text.length>4000||text.includes('\0'))throw new Refused('BAD_TYPED_REQUEST','request note is at most 4000 characters');return text;}
/** Project only this versioned domain's events; ordinary and person requests remain separate. */
export function typedRequests(board,{all=false,requester,itemId}={}){
  const requests=new Map();
  const rows=board.db.prepare("SELECT event_id,event_kind,event_by,item_id,event_detail FROM event WHERE event_kind IN ('typed-request','typed-request-answer') ORDER BY event_id").all();
  for(const row of rows){
    const detail=JSON.parse(row.event_detail);
    if(row.event_kind==='typed-request'){
      const request=detail.request;
      if(request?.version!==1)throw new Refused('BAD_TYPED_REQUEST','unsupported stored typed request version');
      requests.set(row.event_id,{id:row.event_id,item:row.item_id,verb:request.verb,cause:request.cause,
        ...(request.route===undefined?{}:{route:request.route}),note:request.note,requester:row.event_by,status:'open',answer:null});
    }else{
      const request=requests.get(detail.requestId);
      if(!request||request.status!=='open')throw new Refused('BAD_TYPED_REQUEST','stored request answer has no unique open request');
      request.status=detail.outcome;
      request.answer={id:row.event_id,by:row.event_by,outcome:detail.outcome,note:detail.note,eventId:detail.eventId??null};
    }
  }
  return [...requests.values()].filter(row=>(all||row.status==='open')&&(requester===undefined||row.requester===requester)&&(itemId===undefined||row.item===itemId));
}
/** File one exact target/verb/cause using the joined actor's ordinary ordered operation. */
export function fileTypedRequest(board,options){
  requireEngine(board);
  if(!fields(options,['agentId','verb','itemId','cause','route','note']))throw new Refused('BAD_TYPED_REQUEST','request needs a verb, item and fixed cause key');
  const {agentId,verb,itemId,cause,route}=options;
  if(!listAgents(board).some(agent=>agent.agent_id===agentId))throw new Refused('NOT_JOINED','join a lane before filing a typed request');
  if(!TYPED_REQUEST_VERBS.includes(verb)||!positive(itemId))throw new Refused('BAD_TYPED_REQUEST','request reopen|hold|withdraw|reroute names one positive item id');
  if(!TYPED_REQUEST_CAUSES.includes(cause))throw new Refused('BAD_REQUEST_CAUSE',`request cause is one of ${TYPED_REQUEST_CAUSES.join(', ')}`);
  if(verb==='reroute'?!ROUTES.includes(route):route!==undefined)throw new Refused('BAD_TYPED_REQUEST','only reroute takes route light|mid|strong');
  const note=noteOf(options.note);
  return atomic(board,()=>{itemById(board,itemId);logEvent(board,agentId,'typed-request',itemId,
    {request:{version:1,verb,cause,...(route===undefined?{}:{route}),note}});return board.lastEvent.event_id;});
}
/** Verify actual execution and current state; a prose answer or old/reversed move cannot fulfill work. */
function doneEvent(board,request,eventId){
  if(!positive(eventId)||eventId<=request.id)throw new Refused('REQUEST_NOT_ACTED','done needs the exact native operation event after its request');
  const event=board.db.prepare('SELECT event_kind,event_by,item_id,event_detail FROM event WHERE event_id=?').get(eventId);
  const item=itemById(board,request.item);
  if(!event||event.event_by!=='coordinator'||event.item_id!==request.item)throw new Refused('REQUEST_NOT_ACTED','done event must be the coordinator operation on this exact item');
  const detail=JSON.parse(event.event_detail);
  const matches=request.verb==='reopen'?event.event_kind==='reopen'&&item.item_status==='open'
    :request.verb==='hold'?event.event_kind==='hold_item'&&Boolean(item.item_hold_reason)&&item.item_hold_reason===detail.reason
      :request.verb==='withdraw'?event.event_kind==='withdraw'&&item.item_status==='withdrawn'
        :event.event_kind==='edit'&&detail.route===request.route&&item.item_route===request.route;
  if(!matches)throw new Refused('REQUEST_NOT_ACTED','done event or current item does not match the exact requested outcome');
}
/** Answer all requested rows atomically; identical retry is read-only, contradictory retry refuses. */
export function answerTypedRequests(board,options){
  requireEngine(board);
  if(!fields(options,['agentId','answers'])||options.agentId!=='coordinator')throw new Refused('COORDINATOR_ONLY','only the coordinator answers typed requests');
  if(!listAgents(board).some(agent=>agent.agent_id===options.agentId))throw new Refused('NOT_JOINED','join the coordinator seat before answering requests');
  const {answers}=options;
  if(!Array.isArray(answers)||!answers.length||answers.length>200)throw new Refused('BAD_TYPED_REQUEST','answer one to 200 explicit request ids');
  return atomic(board,()=>{
    const requests=new Map(typedRequests(board,{all:true}).map(row=>[row.id,row]));const seen=new Set();
    const plans=answers.map(answer=>{
      if(!fields(answer,['requestId','outcome','note','eventId'])||!positive(answer.requestId)||seen.has(answer.requestId)||!['done','declined'].includes(answer.outcome))throw new Refused('BAD_TYPED_REQUEST','batch answers need unique request ids and done|declined');
      seen.add(answer.requestId);const request=requests.get(answer.requestId);
      if(!request)throw new Refused('NO_TYPED_REQUEST',`no typed request #${answer.requestId}`);
      const note=noteOf(answer.note),eventId=answer.eventId??null;
      if(answer.outcome==='declined'&&(!note||eventId!==null))throw new Refused('BAD_TYPED_REQUEST','declined needs a note and no acted-on event');
      if(request.status!=='open'){
        if(request.status!==answer.outcome||request.answer.note!==note||request.answer.eventId!==eventId)throw new Refused('REQUEST_ALREADY_ANSWERED',`request #${request.id} already has a different answer`);
        return {request,existing:true};
      }
      if(answer.outcome==='done')doneEvent(board,request,eventId);
      return {request,existing:false,outcome:answer.outcome,note,eventId};
    });
    for(const plan of plans)if(!plan.existing)logEvent(board,'coordinator','typed-request-answer',plan.request.item,
      {requestId:plan.request.id,requester:plan.request.requester,outcome:plan.outcome,note:plan.note,...(plan.eventId===null?{}:{eventId:plan.eventId})});
    const result=new Map(typedRequests(board,{all:true}).map(row=>[row.id,row]));return plans.map(plan=>result.get(plan.request.id));
  });
}
