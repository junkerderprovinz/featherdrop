// What the castle loader tells its Rive state machine "loader": mode picks the
// direction the letters fly, progress lights the gate from 0 to 100, still
// swaps the flights for a letter resting at the gate, and reach from 0 to 100
// sends the letters far enough out to come from and go past the window's edge.

export type CastleMode = "idle" | "upload" | "download";

export interface CastleState {
  mode: CastleMode;
  /** The transfer's share from 0 to 1, or null before it reports one. */
  progress: number | null;
  still: boolean;
  /** How far out the letters set off or vanish, from 0 to 100, as castleReach works it out. */
  reach: number;
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
    reach: state.reach,
  };
  for (const input of inputs) {
    if (input.name in values) input.value = values[input.name]!;
  }
}

/** Whether the letter rests at the gate: the system's reduced motion wins, then the app's own level. */
export function stillCastle(motion: string, reducedMotion: boolean) {
  return reducedMotion || motion === "off";
}

// In artboard units from its middle to the nearest edge of a letter as it sets off or vanishes: the
// generator of castle-loader.riv prints both ends, for reach 0 and reach 100.
const ART_WIDTH = 1520;
const REACH_NEAR = 1645;
const REACH_FAR = 4500;

/** The reach that keeps the letters out of sight until they are past a window edge that lies edge
 * pixels from the middle of an artboard drawn width pixels wide. */
export function castleReach(edge: number, width: number) {
  const distance = (edge / width) * ART_WIDTH;
  return Math.min(100, Math.max(0, ((distance - REACH_NEAR) / (REACH_FAR - REACH_NEAR)) * 100));
}
