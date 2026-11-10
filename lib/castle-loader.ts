// What the castle loader tells its Rive state machine "loader": mode picks the
// direction the letters fly, progress lights the gate from 0 to 100, and still
// swaps the flights for a letter resting at the gate.

export type CastleMode = "idle" | "upload" | "download";

export interface CastleState {
  mode: CastleMode;
  /** The transfer's share from 0 to 1, or null before it reports one. */
  progress: number | null;
  still: boolean;
}

/** The part of a Rive state machine input the loader writes to. */
export interface CastleInput {
  readonly name: string;
  value: number | boolean;
}

const MODES: Record<CastleMode, number> = { idle: 0, upload: 1, download: 2 };

export function setCastle(inputs: CastleInput[], state: CastleState) {
  const values: Record<string, number | boolean> = {
    mode: MODES[state.mode],
    progress: Math.min(100, Math.max(0, (state.progress ?? 0) * 100)),
    still: state.still,
  };
  for (const input of inputs) {
    if (input.name in values) input.value = values[input.name]!;
  }
}

/** Whether the letter rests at the gate: the system's reduced motion wins, then the app's own level. */
export function stillCastle(motion: string, reducedMotion: boolean) {
  return reducedMotion || motion === "off";
}
