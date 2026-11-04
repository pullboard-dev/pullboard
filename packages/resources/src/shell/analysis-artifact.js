/** Bounded private-check analysis input carried ahead of the runner history pack [C7]. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
} from 'node:path';

const LIMIT = 64 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;

/** Require a minimal descriptor bound to the exact trusted private-check envelope. */
export function analysisArtifactDescriptor(value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'bytes,context,sha256'
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > LIMIT
    || !HASH.test(value.sha256 ?? '') || !HASH.test(context ?? '') || value.context !== context) {
    throw new Error('invalid runner analysis artifact descriptor');
  }
  return { bytes: value.bytes, sha256: value.sha256, context: value.context };
}

/** Read and verify a controller-owned regular file without following a final-component symlink. */
export function readAnalysisArtifact(value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'bytes,context,file,sha256' || typeof value.file !== 'string' || !isAbsolute(value.file)) {
    throw new Error('invalid runner analysis artifact source');
  }
  const descriptor = analysisArtifactDescriptor({ bytes: value.bytes, sha256: value.sha256, context: value.context }, context);
  const fd = openSync(value.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== descriptor.bytes) throw new Error('invalid runner analysis artifact file');
    const bytes = Buffer.alloc(descriptor.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!read) throw new Error('runner analysis artifact changed');
      offset += read;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) || createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) throw new Error('runner analysis artifact changed');
    return { descriptor, bytes };
  } finally { closeSync(fd); }
}

/** Receive exactly one artifact into the owned job directory and return unread history bytes to stdin. */
export async function receiveAnalysisArtifact(S, directory, descriptor) {
  const file = join(directory, 'analysis-artifact.bin');
  const fd = openSync(file, 'wx', 0o400);
  const hash = createHash('sha256');
  let count = 0, complete = false;
  try {
    await new Promise((resolve, reject) => {
      /** Remove only the listeners owned by this frame, leaving transport custody intact. */
      function cleanup() {
        process.stdin.off('data', onData); process.stdin.off('end', onEnd); process.stdin.off('error', onError); process.stdin.off('close', onClose);
        S.rejectPendingFrame = null;
      }
      /** Terminate a partial frame without handing its bytes to the history reader. */
      function fail(error) { process.stdin.pause(); cleanup(); reject(error); }
      /** Treat premature stream errors as an incomplete input, never a successful check. */
      function onError(error) { fail(error); }
      /** A history pack may follow the frame, but EOF before its length is always a failure. */
      function onEnd() { fail(new Error('incomplete runner analysis artifact')); }
      /** A closed input cannot finish an in-progress frame. */
      function onClose() { fail(new Error('runner analysis artifact stream closed')); }
      /** Persist the exact remaining bytes and preserve any bytes already read for the next protocol stage. */
      function onData(chunk) {
        if (S.transportLost) return fail(new Error('runner transport was lost'));
        try {
          const part = chunk.subarray(0, Math.min(chunk.length, descriptor.bytes - count));
          for (let offset = 0; offset < part.length;) {
            const written = writeSync(fd, part, offset, part.length - offset);
            if (written <= 0) throw new Error('runner analysis artifact write failed');
            offset += written;
          }
          hash.update(part); count += part.length;
          if (count !== descriptor.bytes) return;
          process.stdin.pause();
          cleanup();
          const rest = chunk.subarray(part.length);
          if (rest.length) process.stdin.unshift(rest);
          if (hash.digest('hex') !== descriptor.sha256) return reject(new Error('runner analysis artifact digest mismatch'));
          resolve();
        } catch (error) { fail(error); }
      }
      S.rejectPendingFrame = fail;
      if (S.transportLost || process.stdin.destroyed || process.stdin.readableEnded) return fail(new Error('runner transport was lost'));
      process.stdin.on('data', onData);
      process.stdin.once('end', onEnd);
      process.stdin.once('error', onError);
      process.stdin.once('close', onClose);
      process.stdin.resume();
    });
    complete = true;
    return file;
  } finally {
    closeSync(fd);
    if (!complete) rmSync(file, { force: true });
  }
}
