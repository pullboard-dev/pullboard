/** Build the exact child source for the first-admission-deadline retry fixture. */
export function deadlineRetrySource(gateUrl, resourcesUrl, runner, shellCommand, servicesSource) {
  return `import { withGateSlot, runProfiledShellAsync } from ${JSON.stringify(gateUrl)};
${servicesSource}
import { takeResource } from ${JSON.stringify(resourcesUrl)};
const runner = ${JSON.stringify(runner)};
const blocker = await takeResource({name:'gate',root:process.cwd(),capacity:0,remote:true,scope:'machine',runnerProvider:()=>[runner],runnerWaitMs:15000,agent:'infra-retry-blocker',kind:'submit',itemCheck:true});
const deadline = Date.now() + 75;
// The blocker frees on the retry's wait, never on a clock: at most one poll after the deadline belongs to the first attempt, so the second is the retry's and no load can free the slot before the deadline fires.
let latePolls = 0;
const releaseOnRetry = () => { if (Date.now() >= deadline && ++latePolls === 2) blocker.release(); };
const receipts = [];
const result = await withGateSlot(process.cwd(), lease => runProfiledShellAsync(process.cwd(), ${JSON.stringify(shellCommand)}, {gateLease:lease}),
  {executionServices,remote:true,runnerOnly:true,runnerWaitMs:15000,runnerDeadlineAt:deadline,itemCheck:true,agent:'infra-retry-test',kind:'submit',item:'fixture',onWait:releaseOnRetry,onReceipt:receipt=>receipts.push(receipt)});
const pool = (await import(${JSON.stringify(resourcesUrl)})).listResources({scope:'machine'}).find(row=>row.name==='gate');
console.log(JSON.stringify({green:result.isGreen,output:result.output,receipts,pool:{holders:pool.holders.length,line:pool.line.length}}));`;
}

/** Build an admitted item-check retry scenario whose first execution loses transport after its original wait window. */
export function lateTransportRetrySource(gateUrl, runner, servicesSource) {
  return `import { withGateSlot } from ${JSON.stringify(gateUrl)};
${servicesSource}
import { RunnerDropped } from ${JSON.stringify(new URL('../../index.js', import.meta.url).href)};
const expectedRunner = ${JSON.stringify(runner.host)};let calls=0;const receipts=[];
const result=await withGateSlot(process.cwd(),async lease=>{calls++;if(lease.runner?.host!==expectedRunner)throw new Error('retry changed executor without evidence');if(calls===1){await new Promise(done=>setTimeout(done,260));throw new RunnerDropped(lease.runner.host,{reason:'fixture-late-transport',phase:'ready'});}return {isGreen:true,output:'LATE_RETRY_OK'};},
  {executionServices,remote:true,runnerWaitMs:200,itemCheck:true,agent:'infra-late-test',kind:'submit',item:'fixture',onWait(){},onReceipt:receipt=>receipts.push(receipt)});
console.log(JSON.stringify({green:result.isGreen,output:result.output,calls,receipts}));`;
}
