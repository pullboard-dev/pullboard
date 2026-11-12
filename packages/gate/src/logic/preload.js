/** Pure gate-side preload and machine-home policies, with host inputs supplied by callers [C7]. */
import { join } from 'node:path';
export { machineHome as gateMachineHome } from '../../../kernel/light.js';

/** Return the trusted runtime preload source for an explicit directory. */
export function gateRuntimeCaptureSource(directory) {
  return `const { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } = require('node:fs');
const { basename, dirname, join, relative, resolve } = require('node:path');
const { channel } = require('node:diagnostics_channel');
const { randomUUID } = require('node:crypto');
const { isMainThread } = require('node:worker_threads');
const directory=${JSON.stringify(directory)};
if (isMainThread) {
const file=directory+'/runtime-'+process.pid+'-'+randomUUID()+'.json';
// Observe child identities without replacing spawn or changing any caller arguments/environment.
channel('child_process').subscribe(({process:child})=>{
  if (!child || typeof child.once!=='function') return;
  const record=()=>{
    if (!Number.isSafeInteger(child.pid) || child.pid<1) return;
    try { writeFileSync(directory+'/child-'+process.pid+'-'+child.pid+'.json',JSON.stringify({parent:process.pid,pid:child.pid}),{flag:'wx',mode:0o400}); } catch {}
  };
  if (Number.isSafeInteger(child.pid)) record(); else child.once('spawn',record);
  // Node's native --test parent chooses these workers; bind only its own closed Node child.
  if (process.execArgv.includes('--test')) child.once('close',()=>{
    if (child.spawnfile!==process.execPath || !Number.isSafeInteger(child.pid)) return;
    const selected=child.spawnargs?.at(-1);
    if (typeof selected!=='string' || !/\\.[cm]?js$/u.test(selected)) return;
    try {
      const names=readdirSync(directory).filter(name=>name.startsWith('runtime-'+child.pid+'-')&&name.endsWith('.json'));
      if (names.length!==1) return;
      const path=join(directory,names[0]);
      const stat=lstatSync(path);
      if (!stat.isFile() || stat.mode&0o222 || stat.size>8192) return;
      const own=JSON.parse(readFileSync(path,'utf8'));
      if (own.pid!==child.pid || own.file!==null) return;
      const target=resolve(selected);
      const selectedPath=relative(realpathSync(process.cwd()),join(realpathSync(dirname(target)),basename(target))).replaceAll('\\\\','/');
      const file=selectedPath && !selectedPath.split('/').some(part=>!part||part==='.'||part==='..') && !/[\\r\\n\\0]/u.test(selectedPath) ? selectedPath : null;
      writeFileSync(directory+'/binding-'+child.pid+'.json',JSON.stringify({pid:child.pid,file}),{flag:'wx',mode:0o600});
    } catch { /* An unavailable worker/path remains unknown, never becomes the launcher. */ }
  });
});
writeFileSync(file,JSON.stringify({pid:process.pid,environment:{platform:process.platform,arch:process.arch,node:process.version.slice(1)},file:null}),{flag:'wx',mode:0o400});
// Synchronous spawns have no diagnostics-channel event. An unbound custom process that
// loads child_process cannot prove it is the final executor, even if no async child was seen.
process.once('exit',()=>{
  if (!process.execArgv.includes('--test') && process.moduleLoadList.includes('NativeModule child_process'))
    writeFileSync(directory+'/custom-launcher-'+process.pid+'.json',JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o400});
});
}
// Node's --test parent only starts workers; retain capture until the actual test process boots.
// User code sees its original NODE_OPTIONS, not this recorder's injected option.
if (!process.execArgv.includes('--test')) {
  const ownedPath=${JSON.stringify(join(directory, 'test-runtime-preload.cjs'))};
  for (let index=process.execArgv.length-1; index>=0; index--) {
    if (process.execArgv[index]==='--require='+ownedPath) process.execArgv.splice(index,1);
    else if (process.execArgv[index]==='--require' && process.execArgv[index+1]===ownedPath) process.execArgv.splice(index,2);
  }
  const token=${JSON.stringify('--require=' + JSON.stringify(join(directory, 'test-runtime-preload.cjs')))};
  const options=process.env.NODE_OPTIONS;
  if (options===token) {
    if (process.env.PULLBOARD_RUNTIME_EMPTY_OPTIONS==='1') process.env.NODE_OPTIONS='';
    else delete process.env.NODE_OPTIONS;
  }
  else if (options?.endsWith(' '+token)) process.env.NODE_OPTIONS=options.slice(0,-token.length-1);
  delete process.env.PULLBOARD_RUNTIME_EMPTY_OPTIONS;
}
`;
}
