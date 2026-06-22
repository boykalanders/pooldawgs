export * from "./types.js";
export * from "./constants.js";
export {
  isInsideHole,
  isOutsideBorder,
  shootBall,
  stepWorld,
  type StepHooks,
} from "./physics.js";
export { getRules } from "./variants/index.js";
export {
  CUE_BALL_ID,
  cueBallId,
  createInitialState,
  cloneState,
  cueBall,
  simulateShot,
  validateShot,
  placeCueBall,
  stateHash,
  setSimulator,
  activeBackend,
  type SimulateOptions,
  type ShotValidation,
  type SimulatorFn,
} from "./world.js";
// Havok backend is exported from a SEPARATE entry (./havok) so importing the
// engine core never pulls in Babylon. Use:
//   import { initHavok, simulateShotHavok } from "@pooldawgs/engine/havok";
