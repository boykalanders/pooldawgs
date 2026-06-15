import type { GameRules, GameType } from "../types.js";
import { eightBall } from "./eightball.js";
import { nineBall } from "./nineball.js";
import { snooker } from "./snooker.js";

const REGISTRY: Record<GameType, GameRules<any>> = {
  "8ball": eightBall,
  "9ball": nineBall,
  snooker,
};

export function getRules(type: GameType): GameRules<any> {
  return REGISTRY[type];
}

export { eightBall, nineBall, snooker };
export type { FactsAcc } from "./shared.js";
