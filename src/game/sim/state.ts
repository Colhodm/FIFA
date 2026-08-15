import { DEFAULT_TUNING, type Tuning } from '../tuning';
import { BALL_RADIUS, PITCH_LENGTH, PITCH_WIDTH } from '../constants';
import { FORMATIONS } from '../formations';
import type { Difficulty, FormationId, Role, TeamData, TeamSide } from '../types';
import { mulberry32, type Vec2, type Vec3 } from './math';

export type MatchPhase = 'kickoff' | 'in-play' | 'restart' | 'goal' | 'halftime' | 'end';

export type RestartKind = 'throw-in' | 'goal-kick' | 'corner' | 'free-kick' | 'penalty';

/** Drives the limb animation in the renderer; the sim owns it so replays animate too. */
export type AnimState =
  | 'run'
  | 'kick'
  | 'shot'
  | 'pass'
  | 'tackle'
  | 'slide'
  | 'dive'
  | 'jump'
  | 'skill'
  | 'feint'
  | 'throw'
  | 'celebrate'
  | 'down';

/** Per-player contributions, turned into a match rating on the stats screens. */
export interface PlayerTally {
  goals: number;
  shots: number;
  passes: number;
  tackles: number;
  saves: number;
  fouls: number;
}

export const emptyTally = (): PlayerTally => ({
  goals: 0,
  shots: 0,
  passes: 0,
  tackles: 0,
  saves: 0,
  fouls: 0,
});

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
  /** Height above the turf: non-zero while jumping for a header or diving. */
  height: number;
  verticalVel: number;
  /** Seconds left of the current animation state. */
  animTimer: number;
  anim: AnimState;
  /** -1 / +1 while a keeper is committed to a dive, 0 otherwise. */
  diveDir: number;
  /** Where along the goal line a diving keeper is stretching to. */
  diveTargetZ: number;
  /** Bookings: 2 yellows or a straight red ends the player's match. */
  yellowCards: number;
  sentOff: boolean;
  /** Flagged offside when the ball was last played by a teammate. */
  offside: boolean;
  /** Seconds a skill move keeps the player committed (and a beaten defender off balance). */
  skillTimer: number;
  /** Seconds until this carrier's next touch on the ball. See the touch scheduler in step.ts. */
  touchTimer: number;
  /** Seconds a keeper holds the ball before distributing it. */
  holdTimer: number;
  tally: PlayerTally;
}

/**
 * Out of 10, in the style of a newspaper player rating: everyone starts on a competent 6.5
 * and earns or loses from there.
 */
export function matchRating(player: SimPlayer): number {
  const t = player.tally;
  const raw =
    6.5 +
    t.goals * 1.2 +
    t.shots * 0.12 +
    t.passes * 0.03 +
    t.tackles * 0.18 +
    t.saves * 0.25 -
    t.fouls * 0.25 -
    player.yellowCards * 0.4 -
    (player.sentOff ? 1.5 : 0);
  return Math.round(Math.min(10, Math.max(3, raw)) * 10) / 10;
}

export interface BallState {
  pos: Vec3;
  vel: Vec3;
  /** Quaternion, mirrored from the physics body so snapshots are replay-ready. */
  rot: [number, number, number, number];
  /** Rotational velocity used for curl. Only the y component bends a ball in flight. */
  spin: Vec3;
}

export type BallCommand =
  | { type: 'impulse'; impulse: Vec3; point: Vec3 }
  | { type: 'velocity'; vel: Vec3 }
  | { type: 'teleport'; pos: Vec3 };

export type SimEventType =
  | 'kick'
  | 'pass'
  | 'shot'
  | 'header'
  | 'save'
  | 'tackle'
  | 'skill'
  | 'feint'
  | 'throw'
  | 'foul'
  | 'card'
  | 'offside'
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

/** One line of the on-screen match feed / post-match summary. */
export interface FeedEntry {
  minute: number;
  kind: 'goal' | 'card' | 'foul' | 'offside' | 'save' | 'note';
  side: TeamSide;
  text: string;
}

export interface MatchStats {
  shots: number;
  onTarget: number;
  passes: number;
  fouls: number;
  corners: number;
  offsides: number;
  yellows: number;
  reds: number;
  saves: number;
}

export const emptyStats = (): MatchStats => ({
  shots: 0,
  onTarget: 0,
  passes: 0,
  fouls: 0,
  corners: 0,
  offsides: 0,
  yellows: 0,
  reds: 0,
  saves: 0,
});

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
  /** Gameplay tunables; falls back to the built-in defaults when omitted. */
  tuning?: Tuning;
}

/** State backing manual player switching: the ranking to cycle and the debounce timers. */
export interface SwitchState {
  /** Candidate ids ranked at the first press, cycled by subsequent presses. */
  ranking: number[];
  /** How far through `ranking` the player has cycled. */
  cursor: number;
  /** Seconds since the last switch press, for the cycle window and key-repeat debounce. */
  sincePress: number;
  /** Seconds since a manual switch, during which auto-switch defers to the player. */
  sinceManual: number;
  /** Seconds since the defensive re-evaluation last ran. */
  sinceAuto: number;
}

export interface SimWorld {
  config: MatchConfig;
  /** Resolved gameplay tunables, never undefined once the world exists. */
  tuning: Tuning;
  switching: SwitchState;
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
  /** Player id of the last goalscorer, so the renderer knows who celebrates. */
  lastScorerId: number | null;
  controllerId: number | null;
  /**
   * The man a pass has been played to, and where it was aimed. Without this the only player who
   * goes to meet a pass is whoever happens to be nearest the ball as it leaves the boot — which
   * is never the intended receiver — so defenders, who do attack the ball, win most of them.
   */
  passTarget: { playerId: number; spot: Vec2 } | null;
  /** Seconds since the ball was last struck. Defenders may not react inside their own latency. */
  shotAge: number;
  /** Player id the human is currently controlling. */
  activeId: number;
  kickoffSide: TeamSide;
  /**
   * True from the kickoff whistle until the ball is genuinely in play. Opponents must stay out
   * of the centre circle and cannot take the ball off you before you have played it.
   */
  kickoffProtected: boolean;
  /** The human is holding the rush command: his keeper comes off his line to close the ball. */
  keeperRush: boolean;
  /**
   * A cross is in the air and control is queued to pass to this man — but not until the ball is
   * nearly on him, so the player watches the flight and times the header himself.
   */
  pendingSwitch: number | null;
  restart: SetPiece | null;
  possessionTicks: Record<TeamSide, number>;
  shots: Record<TeamSide, number>;
  stats: Record<TeamSide, MatchStats>;
  feed: FeedEntry[];
  /** Offside only applies once the ball has been played in open play. */
  offsideActive: boolean;
  /** Player who struck the ball this tick; the offside line is redrawn from him. */
  pendingKickId: number | null;
  /** Seconds of stoppage added to the current half. */
  stoppage: number;
  rand: () => number;
  banner: string;
}

export interface SetPiece {
  kind: RestartKind;
  side: TeamSide;
  spot: Vec2;
  takerId: number;
  /** Seconds until the taker may play the ball (players are still walking into position). */
  prepare: number;
  /** Seconds until an AI taker plays it, so a set piece can never stall the match. */
  autoTake: number;
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
        height: 0,
        verticalVel: 0,
        animTimer: 0,
        anim: 'run',
        diveDir: 0,
        yellowCards: 0,
        sentOff: false,
        offside: false,
        diveTargetZ: 0,
        skillTimer: 0,
        touchTimer: 0,
        holdTimer: 0,
        tally: emptyTally(),
      });
    });
  }

  const world: SimWorld = {
    config,
    tuning: config.tuning ?? DEFAULT_TUNING,
    switching: {
      ranking: [],
      cursor: 0,
      sincePress: Infinity,
      sinceManual: Infinity,
      sinceAuto: 0,
    },
    players,
    ball: {
      pos: { x: 0, y: BALL_RADIUS, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      rot: [0, 0, 0, 1],
      spin: { x: 0, y: 0, z: 0 },
    },
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
    lastScorerId: null,
    controllerId: null,
    passTarget: null,
    shotAge: 99,
    activeId: 0,
    kickoffSide: config.humanSide,
    kickoffProtected: false,
    keeperRush: false,
    pendingSwitch: null,
    restart: null,
    possessionTicks: { home: 0, away: 0 },
    shots: { home: 0, away: 0 },
    stats: { home: emptyStats(), away: emptyStats() },
    feed: [],
    offsideActive: false,
    pendingKickId: null,
    stoppage: 0,
    rand: mulberry32(config.seed),
    banner: 'Kick off',
  };

  resetToKickoff(world, config.humanSide);
  return world;
}

/** Places both teams in their formation shape for a kickoff and centres the ball. */
export function resetToKickoff(world: SimWorld, kickoffSide: TeamSide): void {
  // Opponents may not challenge until the ball has been played. See `kickoffProtected`.
  world.kickoffProtected = true;
  world.kickoffSide = kickoffSide;
  world.phase = 'kickoff';
  world.phaseTimer = 2;
  world.restart = null;
  world.controllerId = null;
  world.possession = kickoffSide;
  world.lastTouch = null;

  world.offsideActive = false;

  for (const p of world.players) {
    p.offside = false;
    p.height = 0;
    p.verticalVel = 0;
    p.diveDir = 0;
    p.anim = 'run';
    p.animTimer = 0;
    p.skillTimer = 0;
    p.holdTimer = 0;
    if (p.sentOff) continue;
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
    .filter((p) => p.side === kickoffSide && p.role !== 'GK' && !p.sentOff)
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
  const candidate = world.players.find((p) => p.id === preferred && p.side === human && !p.sentOff);
  if (candidate) return candidate.id;
  const outfield = world.players.find((p) => p.side === human && p.role !== 'GK' && !p.sentOff);
  return outfield ? outfield.id : world.players[0].id;
}

/** Every player still on the pitch. Sent-off players stay in the array for the scoreboard. */
export const onPitch = (world: SimWorld): SimPlayer[] => world.players.filter((p) => !p.sentOff);

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
    height: number;
    gait: number;
    anim: AnimState;
    sentOff: boolean;
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
      spin: { ...world.ball.spin },
    },
    players: world.players.map((p) => ({
      id: p.id,
      side: p.side,
      pos: { ...p.pos },
      vel: { ...p.vel },
      heading: p.heading,
      stamina: p.stamina,
      height: p.height,
      gait: p.gait,
      anim: p.anim,
      sentOff: p.sentOff,
    })),
  };
}
