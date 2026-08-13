import { create } from 'zustand';
import type { Difficulty, FormationId, TeamData, TeamSide } from './types';
import {
  emptyStats,
  type FeedEntry,
  type MatchPhase,
  type MatchStats,
  type RestartKind,
} from './sim/state';
import {
  defaultTier,
  MANUAL_TIER,
  TIERS,
  type QualityMode,
  type QualityTier,
} from './perf/quality';

export type Screen = 'menu' | 'match';

/** Side-on rigs plus the third-person chase cam, mirroring FIFA's camera presets. */
export type CameraMode = 'broadcast' | 'tele' | 'player';

export interface MatchSetup {
  homeTeamId: string;
  awayTeamId: string;
  homeFormation: FormationId;
  awayFormation: FormationId;
  humanSide: TeamSide;
  difficulty: Difficulty;
  /** Real seconds per half. */
  halfLength: number;
}

interface GameState {
  screen: Screen;
  paused: boolean;
  teams: TeamData[];
  teamsError: string | null;
  setup: MatchSetup;
  quality: QualityMode;
  tier: QualityTier;
  camera: CameraMode;
  audioEnabled: boolean;
  /** Bumped on every restart so the scene remounts with a fresh world. */
  matchKey: number;
  setTeams: (teams: TeamData[]) => void;
  setTeamsError: (message: string) => void;
  updateSetup: (patch: Partial<MatchSetup>) => void;
  setQuality: (mode: QualityMode) => void;
  setTier: (id: number) => void;
  setCamera: (mode: CameraMode) => void;
  toggleAudio: () => void;
  startMatch: () => void;
  setPaused: (paused: boolean) => void;
  restartMatch: () => void;
  quitToMenu: () => void;
}

export const useGameStore = create<GameState>((set, get) => ({
  screen: 'menu',
  paused: false,
  teams: [],
  teamsError: null,
  setup: {
    homeTeamId: '',
    awayTeamId: '',
    homeFormation: '4-3-3',
    awayFormation: '4-4-2',
    humanSide: 'home',
    difficulty: 'normal',
    halfLength: 180,
  },
  quality: 'auto',
  tier: TIERS[defaultTier()],
  camera: 'broadcast',
  audioEnabled: true,
  matchKey: 0,
  setTeams: (teams) =>
    set((state) => ({
      teams,
      setup: {
        ...state.setup,
        homeTeamId: state.setup.homeTeamId || teams[0]?.id || '',
        awayTeamId: state.setup.awayTeamId || teams[1]?.id || '',
        homeFormation: teams[0]?.formation ?? state.setup.homeFormation,
        awayFormation: teams[1]?.formation ?? state.setup.awayFormation,
      },
    })),
  setTeamsError: (message) => set({ teamsError: message }),
  updateSetup: (patch) => set((state) => ({ setup: { ...state.setup, ...patch } })),
  setQuality: (mode) =>
    set({ quality: mode, tier: mode === 'auto' ? get().tier : TIERS[MANUAL_TIER[mode]] }),
  setTier: (id) => set({ tier: TIERS[Math.max(0, Math.min(TIERS.length - 1, id))] }),
  setCamera: (mode) => set({ camera: mode }),
  toggleAudio: () => set((state) => ({ audioEnabled: !state.audioEnabled })),
  startMatch: () =>
    set((state) => ({ screen: 'match', paused: false, matchKey: state.matchKey + 1 })),
  setPaused: (paused) => set({ paused }),
  restartMatch: () => set((state) => ({ paused: false, matchKey: state.matchKey + 1 })),
  quitToMenu: () => set({ screen: 'menu', paused: false }),
}));

export const teamById = (teams: TeamData[], id: string): TeamData | undefined =>
  teams.find((t) => t.id === id);

export interface HudState {
  phase: MatchPhase;
  half: 1 | 2;
  minute: number;
  /** Added time at the end of the half, in minutes. */
  stoppage: number;
  score: Record<TeamSide, number>;
  banner: string;
  activeName: string;
  activeShirt: number;
  stamina: number;
  possession: Record<TeamSide, number>;
  shots: Record<TeamSide, number>;
  stats: Record<TeamSide, MatchStats>;
  /** The last few goals, cards, fouls and offsides. */
  feed: FeedEntry[];
  /** Set while a restart is being taken, so the HUD can prompt the taker. */
  setPiece: RestartKind | null;
  replay: boolean;
  /** True while a gamepad is connected, switching the control hints. */
  pad: boolean;
  fps: number;
  tierName: string;
  charge: number;
  set: (patch: Partial<Omit<HudState, 'set'>>) => void;
}

/** High-frequency match readouts live here so menu components never re-render on them. */
export const useHudStore = create<HudState>((set) => ({
  phase: 'kickoff',
  half: 1,
  minute: 0,
  stoppage: 0,
  score: { home: 0, away: 0 },
  banner: '',
  activeName: '',
  activeShirt: 0,
  stamina: 1,
  possession: { home: 50, away: 50 },
  shots: { home: 0, away: 0 },
  stats: { home: emptyStats(), away: emptyStats() },
  feed: [],
  setPiece: null,
  replay: false,
  pad: false,
  fps: 60,
  tierName: 'High',
  charge: 0,
  set: (patch) => set(patch),
}));
