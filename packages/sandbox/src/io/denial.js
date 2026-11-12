/**
 * Sandbox denials (I1, C7): the one classifier for an operating-system permission refusal in gate
 * output, shared by the local gate and the remote runner worker. It ships to runners as a trusted
 * runtime file, so a file denial is resolved against the worktree it happened in, on the machine
 * it happened on, and only its evidence travels.
 */
import {
  realpathSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
} from 'node:path';

/** Resolve existing path prefixes so a symlink cannot hide an outside-worktree operation. */
function diagnosticPath(path) {
  let current = resolve(path);
  const missing = [];
  for (;;) {
    try { return resolve(realpathSync(current), ...missing); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
      const parent = dirname(current);
      if (parent === current) return null;
      missing.unshift(relative(parent, current));
      current = parent;
    }
  }
}

/** Describe one OS permission message, resolving file targets against the command's worktree. */
function permissionOperation(root, message, { includeFilePaths = true } = {}) {
  const network = /^(listen|bind) (EPERM|EACCES)\b/u.exec(message);
  if (network) return { code: network[2], syscall: network[1], operation: `${network[1]} (${network[2]})` };
  if (!includeFilePaths) return null;
  const file = /^(EPERM|EACCES): [^\n]*?, (open|mkdir|read|write|rename|unlink|scandir|access) (['"])([^\n]+?)\3(?= -> |$)/u.exec(message);
  const python = /^PermissionError: \[Errno (?:1|13)\] [^\n]*?: ['"]([^'"\n]+)['"]/u.exec(message);
  if (!file && !python) return null;
  const path = diagnosticPath(resolve(root, file ? file[4] : python[1]));
  const tree = diagnosticPath(root);
  if (!path || !tree) return null;
  const within = relative(tree, path);
  if (within !== '..' && !within.startsWith('../') && !isAbsolute(within)) return null;
  const code = file ? file[1] : 'EACCES';
  return { code, path, syscall: file ? file[2] : null,
    operation: `${file ? file[2] : 'file access'} ${JSON.stringify(path)} (${code})` };
}

/** Decode the single-line quoted YAML scalars emitted by Node's TAP reporter. */
function tapScalar(value) {
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/gu, "'");
  return /^[A-Z_]+$/u.test(value) ? value : null;
}

/** Recognize a bounded child fatal denial carried inside one failed TAP error block. */
function nestedChildPermission(root, lines, { includeFilePaths = true, parentCode = null } = {}) {
  const detail = lines.join('\n');
  const childExit = /\b(?:child|app|server|process)\b[^\n]{0,120}\bexited\b[^\n]{0,100}\bcode\s*[(:=]?\s*([1-9]\d*)/iu.exec(detail);
  // A malformed or zero child-exit statement is evidence against using the footer fallback.
  const childExitMention = /\b(?:child|app|server|process)\b[^\n]{0,120}\bexited\b[^\n]{0,100}\bcode\b/iu.test(detail);
  // Some TAP reporters preserve only stderr as the assertion message. Accept that
  // shape only with an ERR_ASSERTION nonzero-vs-zero footer and a complete fatal
  // signature for the child runtime. Its diagnostic fields below remain mandatory. Scanner lines are
  // trimmed before collection, so stack frames start with `at`, without indentation.
  const bareAssertionExit = !childExit && !childExitMention && parentCode === 'ERR_ASSERTION'
    ? /\n{2,}([1-9]\d*) !== 0\s*$/u.exec(detail) : null;
  const bareFatalDetail = bareAssertionExit ? detail.slice(0, bareAssertionExit.index) : '';
  const completeNodeFatal = bareAssertionExit
    && /(?:^|\n)Node\.js v\d+\.\d+\.\d+\s*$/u.test(bareFatalDetail)
    && /(?:^|\n)at [^\n]+/u.test(bareFatalDetail);
  const childExitCode = childExit ? Number(childExit[1]) : bareAssertionExit ? Number(bareAssertionExit[1]) : null;
  if (!Number.isSafeInteger(childExitCode) || childExitCode <= 0) return null;

  const errorLine = /^\s*Error: (.+)$/mu.exec(detail);
  if (errorLine) {
    if (!childExit && !completeNodeFatal) return null;
    const operation = permissionOperation(root, errorLine[1], { includeFilePaths });
    if (operation?.syscall) {
      const objectStart = detail.indexOf('{', errorLine.index + errorLine[0].length);
      if (objectStart < 0) return null;
      const objectEnd = detail.indexOf('}', objectStart + 1);
      if (objectEnd < 0 || objectEnd - objectStart > 2048) return null;
      const fields = detail.slice(objectStart, objectEnd + 1);
      /** Read one exact structured field, removing only TAP's optional delimiter comma. */
      const fieldValue = (name) => {
        const match = new RegExp(`(?:^|\\n)\\s*${name}:\\s*(.*?)\\s*(?=\\n|$)`, 'u').exec(fields);
        return match ? tapScalar(match[1].replace(/,$/u, '')) : null;
      };
      const code = fieldValue('code');
      const syscall = fieldValue('syscall');
      if (code !== operation.code || syscall !== operation.syscall) return null;
      if (operation.path) {
        const childPath = fieldValue('path');
        if (typeof childPath !== 'string' || diagnosticPath(resolve(root, childPath)) !== operation.path) return null;
      }
      return operation;
    }
  }

  // Python child failures have a standard traceback frame and terminal PermissionError,
  // rather than Node's structured `Error` code/syscall/path object.
  // Node appends this exact assertion comparison to TAP's error scalar after the child stderr.
  // Strip it only for an AssertionError whose nonzero child exit matches `actual !== 0`.
  const assertionFooter = parentCode === 'ERR_ASSERTION'
    ? new RegExp(`\\n{2,}${childExitCode} !== 0\\s*$`, 'u') : null;
  const tracebackDetail = assertionFooter?.test(detail) ? detail.replace(assertionFooter, '') : detail;
  const tracebackMarker = /(?:^|\n)Traceback \(most recent call last\):\n/u.exec(tracebackDetail);
  const tracebackError = /(?:^|\n)(PermissionError: \[Errno (?:1|13)\] [^\n]+)\s*$/u.exec(tracebackDetail);
  if (!tracebackMarker || !tracebackError || tracebackError.index <= tracebackMarker.index) return null;
  const tracebackBody = tracebackDetail.slice(tracebackMarker.index + tracebackMarker[0].length, tracebackError.index);
  if (!/(?:^|\n)File (?:'[^'\n]+'|"[^"\n]+"), line \d+(?:, in [^\n]+)?(?:\n|$)/u.test(tracebackBody)) return null;
  const operation = permissionOperation(root, tracebackError[1], { includeFilePaths });
  return operation && operation.syscall === null ? operation : null;
}

/** Scan complete lines with bounded TAP state so assertion messages cannot impersonate OS codes.
 * With evidence, return the complete denial for the remote file watcher; otherwise keep the local operation string.
 */
export function sandboxBlockedScanner(root, { includeFilePaths = true, evidence = false } = {}) {
  const hit = denial => evidence ? denial : denial.operation;
  let failureIndent = null;
  let fieldIndent = null;
  let permission = null;
  let code = null;
  let comment = null;
  let startup = null;
  let failureMessage = null;
  let failureType = false;
  let exitCode = null;
  let nestedError = null;
  let nestedErrorBytes = 0;
  let nestedErrorLines = 0;
  let nestedErrorOverflow = false;
  const maxNestedErrorBytes = 16 * 1024;
  const maxNestedErrorLines = 64;
  /** Retain one pending fatal diagnostic and the current failed TAP record. */
  return (raw) => {
    const line = raw.trim().replace(/^#\s*/u, '');
    const indent = raw.length - raw.trimStart().length;
    // Node's TAP reporter prints test-console output as comments and assertion details
    // as indented YAML. Neither is a standalone gate diagnostic, even when it contains
    // text that looks exactly like an operating-system denial.
    if (indent === 0 && !raw.startsWith('#') && /^(?:Error: |PermissionError: )/u.test(line)) {
      const direct = permissionOperation(root, line.replace(/^Error: /u, ''), { includeFilePaths });
      if (direct) return hit(direct);
    }
    if (/^TAP version \d+$/u.test(raw)) {
      comment = null; startup = null;
      failureIndent = null; fieldIndent = null; permission = null; code = null;
      failureMessage = null; failureType = false; exitCode = null;
      nestedError = null; nestedErrorBytes = 0; nestedErrorLines = 0; nestedErrorOverflow = false;
    }
    // Uncaught module-load errors are comments too. Keep their complete Node fatal
    // diagnostic pending; it is evidence only if the following file record failed
    // to start. A test logging a caught error and then asserting is not that record.
    if (indent === 0 && raw.startsWith('#')) {
      if (line.startsWith('Error: ')) {
        const operation = permissionOperation(root, line.slice('Error: '.length), { includeFilePaths });
        comment = operation ? { operation, code: null, syscall: null, path: null, closed: false, fatal: false } : null;
      } else if (comment) {
        const field = /^(code|syscall|path): (.*)$/u.exec(line);
        if (field) comment[field[1]] = tapScalar(field[2].replace(/,$/u, ''));
        else if (line === '}') comment.closed = true;
        else if (/^Node\.js v\d+\./u.test(line)) comment.fatal = true;
        else if (line && !/^at |^errno: |^address: |^port: /u.test(line)
          && !(comment.closed && comment.fatal && line.startsWith('Subtest: '))) comment = null;
      }
    }
    if (/^(?:not )?ok \d+\b/u.test(line)) {
      failureIndent = /^not ok /u.test(line) ? indent : null;
      const operation = comment?.operation;
      startup = failureIndent !== null && comment?.closed && comment.fatal
        && comment.code === operation.code && comment.syscall === operation.syscall
        && (!operation.path || (typeof comment.path === 'string'
          && diagnosticPath(resolve(root, comment.path)) === operation.path)) ? operation : null;
      comment = null;
      fieldIndent = null; permission = null; code = null;
      failureMessage = null; failureType = false; exitCode = null;
      nestedError = null; nestedErrorBytes = 0; nestedErrorLines = 0; nestedErrorOverflow = false;
    } else if (line === '---' && failureIndent !== null && indent === failureIndent + 2) {
      fieldIndent = indent;
    } else if (line === '...' && indent === fieldIndent) {
      failureIndent = null; fieldIndent = null; permission = null; code = null;
      startup = null; comment = null;
      failureMessage = null; failureType = false; exitCode = null;
      nestedError = null; nestedErrorBytes = 0; nestedErrorLines = 0; nestedErrorOverflow = false;
    } else if (nestedError !== null && (indent > fieldIndent || line === '')) {
      const nestedLine = line;
      nestedErrorBytes += Buffer.byteLength(nestedLine, 'utf8') + 1;
      nestedErrorLines += 1;
      if (nestedErrorBytes > maxNestedErrorBytes || nestedErrorLines > maxNestedErrorLines) nestedErrorOverflow = true;
      else nestedError.push(nestedLine);
    } else if (fieldIndent !== null && indent === fieldIndent) {
      const field = /^(error|code|failureType|exitCode): (.*)$/u.exec(line);
      if (field) {
        const value = tapScalar(field[2]);
        if (field[1] === 'error') {
          failureMessage = value;
          nestedError = field[2] === '|-' || field[2] === '|' ? [] : null;
          nestedErrorBytes = 0; nestedErrorLines = 0; nestedErrorOverflow = false;
          permission = typeof value === 'string' ? permissionOperation(root, value, { includeFilePaths }) : null;
        } else if (field[1] === 'code') {
          code = value;
          if (code !== 'ERR_TEST_FAILURE') startup = null;
        } else if (field[1] === 'failureType') failureType = value === 'testCodeFailure' || field[2] === 'testCodeFailure';
        else exitCode = /^[1-9]\d*$/u.test(field[2]) && Number.isSafeInteger(Number(field[2])) ? Number(field[2]) : null;
        const nestedPermission = field[1] === 'code'
          && failureType && nestedError && !nestedErrorOverflow
          ? nestedChildPermission(root, nestedError, { includeFilePaths, parentCode: code }) : null;
        if (nestedPermission) return hit(nestedPermission);
        if (permission && permission.code === code) return hit(permission);
        if (startup && code === 'ERR_TEST_FAILURE' && failureMessage === 'test failed'
          && failureType && exitCode !== null) return hit(startup);
      }
    }
    return null;
  };
}

/** Recognize concrete OS permission diagnostics, keeping ordinary assertion failures ordinary. */
export function sandboxBlockedOperation(root, output, options) {
  const scan = sandboxBlockedScanner(root, options);
  for (const line of output.split('\n')) {
    const operation = scan(line);
    if (operation) return operation;
  }
  return null;
}

const FILE_OPERATIONS = new Set(['open', 'mkdir', 'read', 'write', 'rename', 'unlink', 'scandir', 'access', 'file access']);
const LINE_LIMIT = 64 * 1024;

/**
 * Watch streamed command output on the machine that ran it for a file denial outside `root`.
 * Only the evidence leaves: the operation, that its path was outside the worktree, and the errno.
 * Why here: a path can be resolved only on its own machine, so a controller never realpaths a
 * remote path. An over-long line is skipped whole, as the local scanner never sees one either.
 */
export function fileDenialWatcher(root) {
  const scan = sandboxBlockedScanner(root, { evidence: true });
  const decoder = new TextDecoder();
  let pending = '';
  let skipping = false;
  let found = null;
  /** Classify one complete line unless a denial is already in hand. */
  const take = line => {
    const denial = found || skipping ? null : scan(line);
    if (denial?.path) found = { operation: denial.syscall ?? 'file access', outside: true, errno: denial.code };
  };
  return {
    /** Feed one raw output chunk. */
    push(chunk) {
      if (found) return;
      pending += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        take(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        skipping = false;
      }
      if (pending.length > LINE_LIMIT) { pending = ''; skipping = true; }
    },
    /** Finish the stream and return the evidence, or null for an ordinary failure. */
    end() {
      pending += decoder.decode();
      if (pending) take(pending);
      pending = '';
      return found;
    },
  };
}

/**
 * Name a runner's file denial from its evidence alone, with the runner host; null when the
 * evidence is not a well-formed denial, so a malformed receipt cannot pass as one.
 */
export function remoteFileDenial(denial, host) {
  if (!denial || typeof denial !== 'object' || Object.keys(denial).sort().join() !== 'errno,operation,outside'
    || !FILE_OPERATIONS.has(denial.operation) || !['EACCES', 'EPERM'].includes(denial.errno) || denial.outside !== true) return null;
  return `${denial.operation} outside its worktree (${denial.errno}) on runner ${host}`;
}
