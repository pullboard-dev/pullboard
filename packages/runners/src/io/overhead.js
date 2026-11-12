/** Executor phase accounting and bounded cache-tip validation without additional profiling runs [C7]. */

/** Preserve exact cache-tip type checks while replacing one Git launch per tip with one batch. */
export function validateCacheTips(tips, output) {
  const rows = (output.endsWith('\n') ? output.slice(0, -1) : output).split('\n');
  if (!tips.length) {
    if (output) throw new Error('unexpected source cache tip inventory');
    return;
  }
  if (rows.length !== tips.length || tips.some((tip, index) => {
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) commit (0|[1-9][0-9]*)$/u.exec(rows[index]);
    return !match || match[1] !== tip;
  })) throw new Error('source history cache contains a missing or non-commit tip');
}

/** Decode exact bounded cat-file frames before converting annotation bytes to UTF-8. */
export function tagObjectBodies(objects, outputBuffer) {
  const limit = 128 * 1024 * 1024;
  if (!Array.isArray(objects) || objects.length > 8_192
    || objects.some(object => typeof object !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(object))
    || new Set(objects).size !== objects.length || !Buffer.isBuffer(outputBuffer) || outputBuffer.length > limit) {
    throw new Error('source tag batch is invalid or exceeds the safe transfer limit');
  }
  const bodies = new Map();
  let offset = 0;
  for (const object of objects) {
    const headerEnd = outputBuffer.indexOf(10, offset);
    if (headerEnd < offset || headerEnd - offset > 96) throw new Error('source tag batch header is incomplete');
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) tag (0|[1-9][0-9]*)$/u.exec(outputBuffer.toString('utf8', offset, headerEnd));
    if (!match || match[1] !== object) throw new Error('source tag batch contains an unexpected or non-tag object');
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size > limit) throw new Error('source tag batch object exceeds the safe transfer limit');
    const start = headerEnd + 1;
    const end = start + size;
    if (end >= outputBuffer.length || outputBuffer[end] !== 10) throw new Error('source tag batch body is incomplete');
    bodies.set(object, outputBuffer.toString('utf8', start, end));
    offset = end + 1;
  }
  if (offset !== outputBuffer.length) throw new Error('source tag batch contains unexpected trailing bytes');
  return bodies;
}

export { sourcePreparationFields } from '../../../gate/light.js';
