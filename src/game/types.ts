/** Content model. Everything here is loaded from JSON so teams can be swapped without code changes. */

export type Role = 'GK' | 'DF' | 'MF' | 'FW';

/** The six broadcast attributes, 1-99, plus stamina which drives the endurance model. */
export interface PlayerStats {
  pace: number;
  shooting: number;
  passing: number;
  dribbling: number;
  defending: number;
  physical: number;
  stamina: number;
}

export interface PlayerData {
  name: string;
  shirt: number;
  role: Role;
  stats: PlayerStats;
}

/** How the shirt is made up. Every kit used to be drawn with vertical stripes. */
export type KitPattern = 'plain' | 'stripes' | 'sleeves' | 'sash' | 'halves';

export interface Kit {
  primary: string;
  secondary: string;
  shorts: string;
  keeper: string;
  /** Defaults to plain when a team file omits it. */
  pattern?: KitPattern;
}

export interface TeamData {
  id: string;
  name: string;
  shortName: string;
  formation: FormationId;
  /** Squad overall, 1-99. Display only — gameplay reads the individual attributes. */
  rating: number;
  kit: Kit;
  players: PlayerData[];
}

export type FormationId = '4-4-2' | '4-3-3' | '3-5-2' | '5-3-2';

/**
 * A formation slot in normalised attacking space: x = 0 (own goal line) .. 1 (opponent goal line),
 * z = -0.5 (right touchline) .. 0.5 (left touchline).
 */
export interface FormationSlot {
  role: Role;
  x: number;
  z: number;
}

export interface Formation {
  id: FormationId;
  name: string;
  slots: FormationSlot[];
}

export interface TeamsFile {
  teams: TeamData[];
}

export type Difficulty = 'beginner' | 'normal' | 'hard' | 'legendary';

/** A friendly can end in a draw; a knockout tie goes to extra time and penalties. */
export type MatchMode = 'friendly' | 'knockout';

/** Kick-off time, driving the sky, the sun and the floodlights. */
export type TimeOfDay = 'day' | 'evening' | 'night';
export type Weather = 'clear' | 'rain';
export type TeamSide = 'home' | 'away';

/** Three-notch dial used by every sliding team instruction. */
export type TacticLevel = 'low' | 'balanced' | 'high';

/** Team instructions: how a side sets up out of and in possession. */
export interface Tactics {
  /** How aggressively players leave their shape to press the ball. */
  pressing: TacticLevel;
  /** Height of the defensive line. */
  line: TacticLevel;
  /** How far the shape stretches towards the touchlines. */
  width: TacticLevel;
  /** Break quickly when possession is won. */
  counter: boolean;
  /** The back line steps up together to catch runners offside. */
  offsideTrap: boolean;
}

export const DEFAULT_TACTICS: Tactics = {
  pressing: 'balanced',
  line: 'balanced',
  width: 'balanced',
  counter: false,
  offsideTrap: false,
};

/** Numeric weight of a tactic level: 0, 0.5 or 1. */
export const tacticWeight = (level: TacticLevel): number =>
  level === 'low' ? 0 : level === 'high' ? 1 : 0.5;
