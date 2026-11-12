/**
 * Build the ordinary gate slot's light services, loading nothing else from this cell [C7,V4].
 * Why: apps/lib/light.js statically reaches packages/store/index.js through the native board, and a plain test run must leave the store unloaded.
 *
 * @returns {Promise<{ runners: object, landing: object }>} Services shaped for requireGateExecutionServices.
 */
export async function gateSlotServices() {
  return (await import('./src/io/slot/services.js')).gateSlotServices();
}
