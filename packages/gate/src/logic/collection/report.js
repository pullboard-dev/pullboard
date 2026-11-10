/** Landing collection report lines: format and parse, import-free so the test runner reads them without the receipt store [C7,#3056]. */
export const COLLECTION_REPORT_PREFIX = '# pullboard-landing-collection ';
/** Canonical report keys are relative source paths, never basename-only identities. */
function files(values, empty = false) {
  if (!Array.isArray(values) || (!empty && !values.length) || values.some(value => typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.split('/').includes('..'))) return null;
  const normalized=values.map(value=>value.replace(/^\.\//u,''));
  return normalized.every(value=>value&&value!=='.')&&new Set(normalized).size===normalized.length?normalized.sort():null;
}
/** Format one trusted runner observation; malformed inputs remain visibly incomplete. */
export function formatCollectionReport({id,scope,shard=null,full=false,plannedFiles,completedFiles,complete,cleanupVerified}) {
  return COLLECTION_REPORT_PREFIX+JSON.stringify({version:1,id,scope,shard,full:full===true,plannedFiles,completedFiles,complete:complete===true,cleanupVerified:cleanupVerified===true})+'\n';
}
/** Validate one unique matching report; optional expected plan is checked without weakening file identity. */
export function parseCollectionReports(output,{id,scope,shard=null,plannedFiles,requireComplete=true}={}) {
  if(typeof id!=='string'||!/^[a-f0-9-]{36}$/u.test(id)) return null;
  const matching=[];
  for(const line of String(output).split(/\r?\n/u)) {
    if(!line.startsWith(COLLECTION_REPORT_PREFIX))continue;
    let value;
    try {value=JSON.parse(line.slice(COLLECTION_REPORT_PREFIX.length));}
    catch {return null;} // A malformed protocol line cannot establish completion.
    if(!value||typeof value!=='object'||Array.isArray(value))return null;
    if(value.id===id&&value.scope===scope&&value.shard===shard)matching.push(value);
  }
  if(matching.length!==1)return null;
  const report=matching[0],planned=files(report.plannedFiles),completed=files(report.completedFiles,true);
  const wanted=plannedFiles===undefined?planned:files(plannedFiles);
  if(report.version!==1||!['suite','shard'].includes(scope)||(scope==='suite'?shard!==null:typeof shard!=='string')||!planned||!completed||!wanted
    ||JSON.stringify(planned)!==JSON.stringify(wanted)||completed.some(file=>!planned.includes(file))
    ||typeof report.full!=='boolean'||typeof report.complete!=='boolean'||typeof report.cleanupVerified!=='boolean'
    ||report.complete&&(JSON.stringify(planned)!==JSON.stringify(completed)||!report.cleanupVerified)
    ||requireComplete&&report.complete!==true)return null;
  return {...report,plannedFiles:planned,completedFiles:completed};
}
