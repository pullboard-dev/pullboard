/** jobs front door: the durable job store, one row per gate job or landing batch [C7]. */
export { createJob, writeStep, jobView } from "./src/shell/job-store.js";
export { takeJob, renewLease, reclaimLapsed } from "./src/shell/job-lease.js";
export { LEASE_MS, leaseLapsed } from "./src/core/lease-rules.js";
export { shadowSubmitHandoff } from "./src/shell/job-shadow.js";
