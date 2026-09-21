import { cueBallId, type TableState } from "@pooldawgs/engine";

/** HUD hint while the player to shoot has ball in hand. */
export function ballInHandHint(state: TableState): string {
  const zone = state.placementZone ?? "table";
  const where =
    zone === "kitchen" ? "anywhere behind the line" : zone === "d" ? "anywhere in the D" : "anywhere";
  if (state.balls[cueBallId(state)].inHole) {
    return `Ball in hand — drag the cue ball ${where} to place it`;
  }
  const lead = zone === "table" ? "Ball in hand" : "Break";
  return `${lead} — drag the cue ball ${where}, or shoot from where it is`;
}
