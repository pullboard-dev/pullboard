import { testRuntimeRows } from '../../../verify/light.js';
import {
  environmentProblem,
} from '../../../config/light.js';
import {
  basename,
  dirname,
  join,
  relative,
} from 'node:path';
import {
  fileURLToPath,
  pathToFileURL,
} from 'node:url';
import { tmpdir } from 'node:os';
import { fileSystemAdapter } from '../../../fs/index.js';

const fs = fileSystemAdapter();

/** Exact executor identity for gate receipts and landing policy [E27,E28]. */

/** Capture this process on the host that actually executes the command. */
export function executionEnvironment() {
  return { platform: process.platform, arch: process.arch, node: process.versions.node };
}


/** Name an executor when an old verdict differs from its landing host. */
export function environmentLabel(value) {
  return environmentProblem(value) ? 'an unknown environment' : `${value.platform}/${value.arch}, Node ${value.node}`;
}

/** Typed landing fields require the engine that understands their hold and executor semantics. */
export { carriesLandingEnvironment } from '../../browser.js';


/** The exact trusted preload reports from inside each Node process, independently of its launcher. */
export function runtimeCaptureSource(directory) {
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

/** Reuse only the exact native recorder for an admitted worker after its parent restores caller options. */
export function testRuntimeImport(directory = process.env.PULLBOARD_RUNTIME_CAPTURE_DIR) {
  if (!directory) return null;
  const file = join(directory, 'test-runtime-preload.cjs');
  try {
    return fs.readFile(file, 'utf8') === runtimeCaptureSource(directory) ? pathToFileURL(file).href : null;
  } catch { return null; /* An absent or foreign recorder never becomes an import. */ }
}

/** Use the validated recorder before Node's native test parent starts workers, without adding execArgv. */
export function testRuntimeOption(directory = process.env.PULLBOARD_RUNTIME_CAPTURE_DIR) {
  const imported = testRuntimeImport(directory);
  return imported ? '--require=' + JSON.stringify(fileURLToPath(imported)) : null;
}

/** Bind a closed admitted worker's self-report to the file selected by its parent, never by test stdout. */
export function bindTestRuntime(pid, file) {
  const directory = process.env.PULLBOARD_RUNTIME_CAPTURE_DIR;
  if (!directory) return null;
  try {
    const names = fs.list(directory).filter(name => name.startsWith('runtime-' + pid + '-') && name.endsWith('.json'));
    if (names.length !== 1) return false;
    const path = join(directory, names[0]);
    const stat = fs.lstat(path);
    if (!stat.isFile() || stat.mode & 0o222) return false;
    const own = JSON.parse(fs.readFile(path, 'utf8'));
    if (own.pid !== pid || own.file !== null || environmentProblem(own.environment)) return false;
    const selected = relative(fs.realpath(process.cwd()), join(fs.realpath(dirname(file)), basename(file))).replaceAll('\\', '/');
    // Accepted callers may select a real test outside the checkout; never invent an in-repo path for it.
    const bound = { pid, environment: own.environment, file: selected.split('/').includes('..') ? null : selected };
    if (!testRuntimeRows([bound])) return false;
    fs.writeFile(join(directory, 'binding-' + pid + '.json'), JSON.stringify({ pid, file: bound.file }), { flag: 'wx', mode: 0o600 });
    return true;
  } catch { return false; /* A missing child report cannot be replaced by the parent's identity. */ }
}

/** Capture actual Node children in a private run directory without changing test output or the machine pool. */
export function captureTestRuntimes(env) {
  const directory = fs.mkdtemp(join(process.env.PULLBOARD_SCRATCH || tmpdir(), 'pullboard-test-runtimes-'));
  const preload = join(directory, 'test-runtime-preload.cjs');
  fs.writeFile(preload, runtimeCaptureSource(directory), { flag: 'wx', mode: 0o600 });
  let finished = false;
  return {
    env: { ...env, NODE_OPTIONS: [env.NODE_OPTIONS, '--require=' + JSON.stringify(preload)].filter(Boolean).join(' '),
      PULLBOARD_RUNTIME_CAPTURE_DIR: directory, PULLBOARD_RUNTIME_EMPTY_OPTIONS: env.NODE_OPTIONS === '' ? '1' : '0' },
    /** Read bounded child reports only after command close, then remove the private capture directory. */
    finish() {
      if (finished) return null;
      finished = true;
      try {
        const entries = fs.list(directory);
        if (entries.length > 200_001) return null;
        const names = entries.filter(name => /^runtime-[0-9]+-[a-f0-9-]+\.json$/u.test(name));
        if (names.length > 100_000) return null;
        const rows = [];
        const boundPids = new Set();
        let bytes = 0;
        for (const name of names.sort()) {
          const file = join(directory, name);
          const stat = fs.lstat(file);
          bytes += stat.size;
          if (!stat.isFile() || stat.mode & 0o222 || stat.size > 8192 || bytes > 8 * 1024 * 1024) return null;
          const row = JSON.parse(fs.readFile(file, 'utf8'));
          if (row.file !== null) return null;
          const binding = join(directory, 'binding-' + row.pid + '.json');
          try {
            const boundStat = fs.lstat(binding);
            if (!boundStat.isFile() || boundStat.size > 8192) return null;
            const bound = JSON.parse(fs.readFile(binding, 'utf8'));
            if (Object.keys(bound).sort().join(',') !== 'file,pid' || bound.pid !== row.pid) return null;
            row.file = bound.file;
            boundPids.add(row.pid);
          } catch (error) { if (error.code !== 'ENOENT') return null; }
          rows.push(row);
        }
        const checked = testRuntimeRows(rows);
        if (!checked) return null;
        const files = checked.filter(row => boundPids.has(row.pid));
        if (files.length) return files;
        const reported = new Set(checked.map(row => row.pid));
        for (const name of entries.filter(name => /^custom-launcher-[0-9]+\.json$/u.test(name))) {
          const path = join(directory, name);
          const stat = fs.lstat(path);
          if (!stat.isFile() || stat.mode & 0o222 || stat.size > 8192) return null;
          const custom = JSON.parse(fs.readFile(path, 'utf8'));
          if (Object.keys(custom).join(',') !== 'pid' || !Number.isSafeInteger(custom.pid) || custom.pid < 1
            || name !== 'custom-launcher-' + custom.pid + '.json') return null;
          if (reported.has(custom.pid)) return null;
        }
        const launchers = new Set();
        for (const name of entries.filter(name => /^child-[0-9]+-[0-9]+\.json$/u.test(name))) {
          const path = join(directory, name);
          const stat = fs.lstat(path);
          bytes += stat.size;
          if (!stat.isFile() || stat.mode & 0o222 || stat.size > 8192 || bytes > 8 * 1024 * 1024) return null;
          const child = JSON.parse(fs.readFile(path, 'utf8'));
          if (Object.keys(child).sort().join(',') !== 'parent,pid' || !Number.isSafeInteger(child.parent) || child.parent < 1
            || !Number.isSafeInteger(child.pid) || child.pid < 1 || name !== 'child-' + child.parent + '-' + child.pid + '.json') return null;
          // An unbound launcher's own runtime cannot stand in for an unobserved custom descendant.
          if (reported.has(child.parent) && !reported.has(child.pid)) return null;
          launchers.add(child.parent);
        }
        return testRuntimeRows(checked.filter(row => !launchers.has(row.pid)));
      } catch { return null; /* Missing or incomplete self-reports stay unknown, never become the launcher runtime. */ }
      finally { fs.rm(directory, { recursive: true, force: true }); }
    },
  };
}
