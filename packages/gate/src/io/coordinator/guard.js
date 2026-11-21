/** No test process starts on the coordinator: the guard lives in the config cell and is re-exported here [C7]. */
export {
  RUNNER_JOB_ENV,
  TESTS_ON_COORDINATOR,
  isCoordinatorMachine,
  coordinatorTestRefusal,
  refuseTestsOnCoordinator,
  testProcesses,
} from '../../../../config/index.js';
