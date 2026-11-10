/** Additive typed routing declarations retain exact actor and receiver floors [N26,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MOVE_REGISTRY } from '../../../packages/moves/index.js';
import { minimumMoveEngine } from '../../../packages/moves/index.js';
import { nativeBoardPorts } from '../index.js';
const { relayMoveActor } = nativeBoardPorts().enginePorts;
import { TYPED_REQUESTS_ENGINE } from '../../../packages/state/light.js';
export const TYPED_REQUEST_OPERATIONS=Object.freeze(['fileTypedRequest','answerTypedRequests']);
export const TYPED_REQUEST_STEPS=Object.freeze({
  "BAD_TYPED_REQUEST": "use request reopen|hold|withdraw|reroute <id> --cause <key>, or request answer <ids> done|declined",
  "BAD_REQUEST_CAUSE": "choose a fixed cause key from pullboard help request",
  "REQUEST_NOT_ACTED": "run the original coordinator move, then name its exact native event with --acted-on",
  "NO_TYPED_REQUEST": "list queued requests with pullboard request list --all",
  "REQUEST_ALREADY_ANSWERED": "read the recorded answer with pullboard request list --all"
});

test('typed queue descriptors bind only the exact options actor and require their own engine [N26,H16]',()=>{
  for(const operation of TYPED_REQUEST_OPERATIONS){
    assert.equal(MOVE_REGISTRY[operation].engine,TYPED_REQUESTS_ENGINE);
    assert.equal(minimumMoveEngine(operation,[]),TYPED_REQUESTS_ENGINE);
    assert.equal(MOVE_REGISTRY[operation].itemIdFirstArgument,false,'queue identity is not delegated item authority');
    assert.equal(relayMoveActor({operation,args:[{agentId:'typed-request-seat'}]}),'typed-request-seat');
    assert.equal(relayMoveActor({operation,args:[7,{agentId:'wrong-slot'}]}),null);
    assert.equal(relayMoveActor({operation,args:[]}),null);
    assert.deepEqual(MOVE_REGISTRY[operation].nextSteps,TYPED_REQUEST_STEPS);
  }
});
