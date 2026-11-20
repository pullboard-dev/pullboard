/** Resources light door: the lease, capacity and recovery names the runner worker uses [C7]. */
export { BROWSER_REFUSAL_FILE, BROWSER_REFUSAL_FILE_ENV, gateSlotEnvironment, holdsLease, setResourceCapacity, takeResource, updateRunnerSettings } from './src/io/main.js';
export { recoveryIdentity } from './src/io/recovery.js';
export { openPoolReadOnly } from './src/io/lock.js';
export { analysisArtifactDescriptor, receiveAnalysisArtifact } from './src/io/artifact.js';
export { machineHome, machineSettingsFile, withMachineHomeWrite } from './src/io/home.js';
