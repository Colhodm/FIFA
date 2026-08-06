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

export interface Kit {
  primary: string;
  secondary: string;
  shorts: string;
  keeper: string;
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
export type TeamSide = 'home' | 'away';
