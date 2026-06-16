import type { BallColor, TableState } from "@pooldawgs/engine";

/** The ball the current shooter must legally hit first ("ball on"). */
export type Target =
  | { kind: "number"; number: number } // 9-ball: lowest ball on the table
  | { kind: "red" } // snooker: a red is on
  | { kind: "colour" } // snooker: any colour is on (just potted a red)
  | { kind: "color"; color: BallColor } // snooker (no reds left): the lowest colour
  | null;

// Snooker colours in ascending point value — the order they become "on" once
// the reds are gone.
const SNOOKER_ORDER: BallColor[] = ["yellow", "green", "brown", "blue", "pink", "black"];

/** What the shooter must hit first, for 9-ball and snooker. (8-ball shows its
 *  group tracker in the player cards instead, so it returns null here.) */
export function targetBall(state: TableState): Target {
  if (state.gameOver) return null;
  const live = state.balls.filter((b) => !b.inHole && b.color !== "cue");

  if (state.gameType === "9ball") {
    let lowest: number | null = null;
    for (const b of live) if (lowest === null || b.number < lowest) lowest = b.number;
    return lowest === null ? null : { kind: "number", number: lowest };
  }

  if (state.gameType === "snooker") {
    const redsLeft = live.some((b) => b.color === "red");
    if (redsLeft) return state.onColor ? { kind: "colour" } : { kind: "red" };
    const colour = SNOOKER_ORDER.find((c) => live.some((b) => b.color === c));
    return colour ? { kind: "color", color: colour } : null;
  }

  return null;
}

const COLOUR_LABEL: Partial<Record<BallColor, string>> = {
  yellow: "yellow",
  green: "green",
  brown: "brown",
  blue: "blue",
  pink: "pink",
  black: "black",
};

/** Short label for the "ball on", e.g. "Hit the 3" / "On a red". */
export function targetLabel(t: Target): string {
  if (!t) return "";
  switch (t.kind) {
    case "number":
      return `Hit the ${t.number}`;
    case "red":
      return "On a red";
    case "colour":
      return "On a colour";
    case "color":
      return `On the ${COLOUR_LABEL[t.color] ?? t.color}`;
  }
}
