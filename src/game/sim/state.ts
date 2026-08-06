import { BALL_RADIUS, PITCH_LENGTH, PITCH_WIDTH } from '../constants';
import { FORMATIONS } from '../formations';
import type { Difficulty, FormationId, Role, TeamData, TeamSide } from '../types';
import { mulberry32, type Vec2, type Vec3 } from './math';

export type MatchPhase = 'kickoff' | 'in-play' | 'restart' | 'goal' | 'halftime' | 'end';

export type RestartKind = 'throw-in' | 'goal-kick' | 'corner';

export interface SimPlayer {
  id: number;
  side: TeamSide;
  /** Index within the team, 0 is always the goalkeeper. */
  index: number;
  name: string;
  shirt: number;
  role: Role;
  pace: number;
  shooting: number;
  passing: number;
  dribbling: number;
  defending: number;
  physical: number;
  enduranceRating: number;
  pos: Vec2;
  vel: Vec2;
  heading: number;
  /** 0..1, drains while sprinting and caps top speed when low. */
  stamina: number;
  /** Seconds until this player may touch the ball again. */
  kickCooldown: number;
  /** Run-cycle phase in radians, advanced by distance travelled so strides match the ground. */
  gait: number;
  /** Seconds until the AI re-evaluates (models reaction time). */
  thinkTimer: number;
  /** Cached AI intent, refreshed on the reaction-time cadence. */
  intent: Vec2;
  intentSprint: boolean;
  /** Jockeying (off the ball) or shielding (on it) — slower, but much harder to beat. */
  shielding: boolean;
  /** Formation slot in normalised attacking space. */
  slot: Vec2;
  slotRole: Role;
}

export interface BallState {
  pos: Vec3;
  vel: Vec3;
  /** Quaternion, mirrored from the physics body so snapshots are replay-ready. */
  rot: [number, number, number, number];
}

export type BallCommand =
  | { type: 'impulse'; impulse: Vec3; point: Vec3 }
  | { type: 'velocity'; vel: Vec3 }
  | { type: 'teleport'; pos: Vec3 };

export type SimEventType =
  | 'kick'
  | 'pass'
  | 'shot'
  | 'save'
  | 'tackle'
  | 'goal'
  | 'whistle'
  | 'kickoff'
  | 'out'
  | 'halftime'
  | 'fulltime';

export interface SimEvent {
  type: SimEventType;
  side?: TeamSide;
  /** 0..1 loudness / power hint for audio. */
  intensity?: number;
  text?: string;
}

export interface DifficultyProfile {
  /** Seconds between AI re-decisions. */
  reaction: number;
  /** 0..1, how eagerly the CPU spends stamina. */
  sprintBias: number;
  /** 0..1, how tightly the CPU marks and presses. */
  marking: number;
  /** 0..1, shot placement quality. */
  shotAccuracy: number;
  passAccuracy: number;
}

export const DIFFICULTY: Record<Difficulty, DifficultyProfile> = {
  beginner: {
    reaction: 0.5,
    sprintBias: 0.35,
    marking: 0.5,
    shotAccuracy: 0.45,
    passAccuracy: 0.68,
  },
  normal: {
    reaction: 0.28,
    sprintBias: 0.65,
    marking: 0.75,
    shotAccuracy: 0.7,
    passAccuracy: 0.84,
  },
  hard: { reaction: 0.16, sprintBias: 0.85, marking: 0.9, shotAccuracy: 0.85, passAccuracy: 0.92 },
  legendary: { reaction: 0.08, sprintBias: 1, marking: 1, shotAccuracy: 0.95, passAccuracy: 0.97 },
};

/** The AI profile used for the human player's own AI-controlled teammates. */
export const TEAMMATE_PROFILE: DifficultyProfile = DIFFICULTY.normal;

export interface MatchConfig {
  homeTeam: TeamData;
  awayTeam: TeamData;
  homeFormation: FormationId;
  awayFormation: FormationId;
  humanSide: TeamSide;
  difficulty: Difficulty;
  /** Real seconds per half. */
  halfLength: number;
  seed: number;
}

export interface SimWorld {
  config: MatchConfig;
  players: SimPlayer[];
  ball: BallState;
  /** Drained by the physics layer every tick. */
  commands: BallCommand[];
  /** Drained by the audio/HUD layer every tick. */
  events: SimEvent[];
  phase: MatchPhase;
  phaseTimer: number;
  half: 1 | 2;
  /** Seconds played in the current half. */
  clock: number;
  score: Record<TeamSide, number>;
  /** +1 means the side attacks towards +x. Flips at halftime. */
  attackDir: Record<TeamSide, 1 | -1>;
  possession: TeamSide | null;
  lastTouch: { side: TeamSide; playerId: number } | null;
  lastScorer: TeamSide | null;
  controllerId: number | null;
  /** Player id the human is currently controlling. */
  activeId: number;
  kickoffSide: TeamSide;
  restart: { kind: RestartKind; side: TeamSide; spot: Vec2; takerId: number } | null;
  possessionTicks: Record<TeamSide, number>;
  shots: Record<TeamSide, number>;
  rand: () => number;
  banner: string;
}

export const teamOf = (world: SimWorld, side: TeamSide): TeamData =>
  side === 'home' ? world.config.homeTeam : world.config.awayTeam;

/** Maps a formation slot (attacking space) into pitch coordinates for a side. */
export function slotToPitch(slot: Vec2, dir: 1 | -1): Vec2 {
  return {
    x: (slot.x - 0.5) * PITCH_LENGTH * dir,
    z: slot.z * PITCH_WIDTH * dir,
  };
}

export function createWorld(config: MatchConfig): SimWorld {
  const players: SimPlayer[] = [];
  let id = 0;
  for (const side of ['home', 'away'] as TeamSide[]) {
    const team = side === 'home' ? config.homeTeam : config.awayTeam;
    const formation = FORMATIONS[side === 'home' ? config.homeFormation : config.awayFormation];
    formation.slots.forEach((slot, index) => {
      const data = team.players[index] ?? team.players[team.players.length - 1];
      players.push({
        id: id++,
        side,
        index,
        name: data.name,
        shirt: data.shirt,
        role: slot.role,
        pace: data.stats.pace,
        shooting: data.stats.shooting,
        passing: data.stats.passing,
        dribbling: data.stats.dribbling,
        defending: data.stats.defending,
        physical: data.stats.physical,
        enduranceRating: data.stats.stamina,
        pos: { x: 0, z: 0 },
        vel: { x: 0, z: 0 },
        heading: 0,
        stamina: 1,
        kickCooldown: 0,
        gait: 0,
        thinkTimer: 0,
        intent: { x: 0, z: 0 },
        intentSprint: false,
        shielding: false,
        slot: { x: slot.x, z: slot.z },
        slotRole: slot.role,
      });
    });
  }

  const world: SimWorld = {
    config,
    players,
    ball: { pos: { x: 0, y: BALL_RADIUS, z: 0 }, vel: { x: 0, y: 0, z: 0 }, rot: [0, 0, 0, 1] },
    commands: [],
    events: [],
    phase: 'kickoff',
    phaseTimer: 2,
    half: 1,
    clock: 0,
    score: { home: 0, away: 0 },
    attackDir: { home: 1, away: -1 },
    possession: null,
    lastTouch: null,
    lastScorer: null,
    controllerId: null,
    activeId: 0,
    kickoffSide: config.humanSide,
    restart: null,
    possessionTicks: { home: 0, away: 0 },
    shots: { home: 0, away: 0 },
    rand: mulberry32(config.seed),
    banner: 'Kick off',
  };

  resetToKickoff(world, config.humanSide);
  return world;
}

/** Places both teams in their formation shape for a kickoff and centres the ball. */
export function resetToKickoff(world: SimWorld, kickoffSide: TeamSide): void {
  world.kickoffSide = kickoffSide;
  world.phase = 'kickoff';
  world.phaseTimer = 2;
  world.restart = null;
  world.controllerId = null;
  world.possession = kickoffSide;
  world.lastTouch = null;

  for (const p of world.players) {
    const dir = world.attackDir[p.side];
    const base = slotToPitch(p.slot, dir);
    // Squeeze both teams into their own half for the kickoff.
    const own = Math.min(base.x * dir, -1.5) * dir;
    p.pos = { x: own, z: base.z };
    p.vel = { x: 0, z: 0 };
    p.heading = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    p.kickCooldown = 0;
    p.thinkTimer = 0;
    p.intent = { x: 0, z: 0 };
  }

  // The kickoff side puts two players on the ball.
  const takers = world.players
    .filter((p) => p.side === kickoffSide && p.role !== 'GK')
    .sort((a, b) => Math.abs(a.pos.z) - Math.abs(b.pos.z))
    .slice(0, 2);
  takers.forEach((p, i) => {
    p.pos = { x: -0.8 * world.attackDir[p.side], z: i === 0 ? -0.6 : 1.4 };
    p.heading = world.attackDir[p.side] > 0 ? Math.PI / 2 : -Math.PI / 2;
  });

  world.ball.pos = { x: 0, y: BALL_RADIUS, z: 0 };
  world.ball.vel = { x: 0, y: 0, z: 0 };
  world.commands.push({ type: 'teleport', pos: { x: 0, y: BALL_RADIUS, z: 0 } });
  world.activeId = pickActive(world, takers[0]?.id ?? world.activeId);
}

function pickActive(world: SimWorld, preferred: number): number {
  const human = world.config.humanSide;
  const candidate = world.players.find((p) => p.id === preferred && p.side === human);
  if (candidate) return candidate.id;
  const outfield = world.players.find((p) => p.side === human && p.role !== 'GK');
  return outfield ? outfield.id : world.players[0].id;
}

/** Plain-JSON snapshot of everything needed to restore or replay a match state. */
export interface WorldSnapshot {
  tick: number;
  phase: MatchPhase;
  half: 1 | 2;
  clock: number;
  score: Record<TeamSide, number>;
  ball: BallState;
  players: {
    id: number;
    side: TeamSide;
    pos: Vec2;
    vel: Vec2;
    heading: number;
    stamina: number;
  }[];
}

export function snapshot(world: SimWorld, tick: number): WorldSnapshot {
  return {
    tick,
    phase: world.phase,
    half: world.half,
    clock: world.clock,
    score: { ...world.score },
    ball: {
      pos: { ...world.ball.pos },
      vel: { ...world.ball.vel },
      rot: [...world.ball.rot] as [number, number, number, number],
    },
    players: world.players.map((p) => ({
      id: p.id,
      side: p.side,
      pos: { ...p.pos },
      vel: { ...p.vel },
      heading: p.heading,
      stamina: p.stamina,
    })),
  };
}
