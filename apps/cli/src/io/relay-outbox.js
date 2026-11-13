import { CONFIG_FILE } from '../../../../packages/config/index.js';
import { configFromSource } from '../../../../packages/config/index.js';
import { coordinatorFile } from './coordinator-file.js';

/**
 * Whether the board's committed relay.outbox setting queues moves while the relay is down (#922, H21).
 * Why: absent means enabled for existing boards; an explicit false is the shared opt-out. Its own file so the sync step needs no claim.js [C7].
 */
export function relayOutboxSetting(root) {
  try { return configFromSource(coordinatorFile(root, CONFIG_FILE).stdout).relay?.outbox !== false; } catch { return false; }
}
