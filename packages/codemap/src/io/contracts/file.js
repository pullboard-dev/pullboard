/** A consumer contract file records which exports a consumer relies on from a provider cell [C7]. */
import { Refused } from '../../../../kernel/light.js';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fileSystem = fileSystemAdapter();

const MALFORMED = 'the contract file must be JSON with string consumer and provider and an exports list of { name, params: string[], returns }; rewrite it with writeContractFile and retry';

/**
 * Check a parsed contract has the consumer, provider and export shapes.
 * @param {unknown} value parsed contract
 * @returns {{ consumer: string, provider: string, exports: { name: string, params: string[], returns: string }[] }}
 */
function validContract(value) {
  const ok = value && typeof value === 'object' && typeof value.consumer === 'string' && typeof value.provider === 'string'
    && Array.isArray(value.exports) && value.exports.every(shape => shape && typeof shape.name === 'string'
      && Array.isArray(shape.params) && shape.params.every(param => typeof param === 'string') && typeof shape.returns === 'string');
  if (!ok) throw new Refused('CONTRACT_MALFORMED', MALFORMED);
  return {
    consumer: value.consumer,
    provider: value.provider,
    exports: value.exports.map(({ name, params, returns }) => ({ name, params: [...params], returns })),
  };
}

/** Write one consumer contract file; a malformed contract is refused before any byte is written. */
export function writeContractFile(path, contract) {
  fileSystem.writeFile(path, `${JSON.stringify(validContract(contract), null, 2)}\n`);
}

/** Read one consumer contract file back; unparseable or misshapen content refuses CONTRACT_MALFORMED. */
export function readContractFile(path) {
  let parsed;
  try { parsed = JSON.parse(fileSystem.readFile(path, 'utf8')); } catch { throw new Refused('CONTRACT_MALFORMED', MALFORMED); }
  return validContract(parsed);
}
