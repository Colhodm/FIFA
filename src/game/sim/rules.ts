import {
  BALL_RADIUS,
  GOAL_HEIGHT,
  HALF_GOAL_WIDTH,
  HALF_LENGTH,
  HALF_WIDTH,
  PENALTY_BOX_DEPTH,
} from '../constants';
import type { TeamSide } from '../types';
import { nearestOf } from './ai';
import { clamp, type Vec2 } from './math';
import { resetToKickoff, type RestartKind, type SimWorld } from './state';

const other = (side: TeamSide): TeamSide => (side === 'home' ? 'away' : 'home');

/** Side attacking towards +x / -x. */
function sideAttacking(world: SimWorld, dir: 1 | -1): TeamSide {
  return world.attackDir.home === dir ? 'home' : 'away';
}

export function stopBall(world: SimWorld, spot: Vec2): void {
  world.ball.pos = { x: spot.x, y: BALL_RADIUS, z: spot.z };
  world.ball.vel = { x: 0, y: 0, z: 0 };
  world.commands.push({ type: 'teleport', pos: { x: spot.x, y: BALL_RADIUS, z: spot.z } });
}

export function setupRestart(world: SimWorld, kind: RestartKind, side: TeamSide, spot: Vec2): void {
  stopBall(world, spot);
  const taker =
    kind === 'goal-kick'
      ? (world.players.find((p) => p.side === side && p.role === 'GK') ?? null)
      : nearestOf(world, spot, side);
  if (taker) {
    const inward = { x: -Math.sign(spot.x) * 1.2, z: -Math.sign(spot.z) * 1.2 };
    taker.pos = { x: spot.x + inward.x, z: spot.z + inward.z };
    taker.vel = { x: 0, z: 0 };
    taker.kickCooldown = 0;
    if (side === world.config.humanSide && taker.role !== 'GK') world.activeId = taker.id;
  }
  world.restart = { kind, side, spot, takerId: taker?.id ?? -1 };
  world.phase = 'restart';
  world.phaseTimer = 1.1;
  world.possession = side;
  world.controllerId = null;
  world.banner = kind === 'throw-in' ? 'Throw-in' : kind === 'corner' ? 'Corner kick' : 'Goal kick';
  world.events.push({ type: 'out', side });
}

/** Goal, throw-in, corner and goal-kick detection. Returns true when play was interrupted. */
export function checkBallOut(world: SimWorld): boolean {
  const { x, y, z } = world.ball.pos;

  if (Math.abs(x) > HALF_LENGTH + BALL_RADIUS) {
    const dir: 1 | -1 = x > 0 ? 1 : -1;
    const scorer = sideAttacking(world, dir);
    const defender = other(scorer);
    const isGoal = Math.abs(z) < HALF_GOAL_WIDTH - BALL_RADIUS && y < GOAL_HEIGHT;
    if (isGoal) {
      scoreGoal(world, scorer);
      return true;
    }
    const lastSide = world.lastTouch?.side ?? scorer;
    if (lastSide === scorer) {
      setupRestart(world, 'goal-kick', defender, {
        x: (HALF_LENGTH - PENALTY_BOX_DEPTH + 5) * dir,
        z: clamp(z, -12, 12),
      });
    } else {
      setupRestart(world, 'corner', scorer, {
        x: (HALF_LENGTH - 0.6) * dir,
        z: Math.sign(z || 1) * (HALF_WIDTH - 0.6),
      });
    }
    return true;
  }

  if (Math.abs(z) > HALF_WIDTH + BALL_RADIUS) {
    const lastSide = world.lastTouch?.side ?? 'home';
    setupRestart(world, 'throw-in', other(lastSide), {
      x: clamp(x, -HALF_LENGTH + 2, HALF_LENGTH - 2),
      z: Math.sign(z) * (HALF_WIDTH - 0.3),
    });
    return true;
  }

  return false;
}

export function scoreGoal(world: SimWorld, side: TeamSide): void {
  world.score[side] += 1;
  world.lastScorer = side;
  world.phase = 'goal';
  world.phaseTimer = 3.6;
  world.possession = null;
  world.controllerId = null;
  const team = side === 'home' ? world.config.homeTeam : world.config.awayTeam;
  world.banner = `GOAL! ${team.name}`;
  world.events.push({ type: 'goal', side, intensity: 1 });
  world.events.push({ type: 'whistle', intensity: 0.6 });
}

/** Advances the half clock and drives half-time / full-time transitions. */
export function advanceClock(world: SimWorld, dt: number): void {
  world.clock += dt;
  if (world.clock < world.config.halfLength) return;
  world.clock = world.config.halfLength;
  if (world.half === 1) {
    world.phase = 'halftime';
    world.phaseTimer = 4;
    world.banner = 'Half time';
    world.events.push({ type: 'halftime' });
    world.events.push({ type: 'whistle', intensity: 0.8 });
  } else {
    world.phase = 'end';
    world.phaseTimer = 0;
    world.banner = 'Full time';
    world.events.push({ type: 'fulltime' });
    world.events.push({ type: 'whistle', intensity: 1 });
  }
}

export function startSecondHalf(world: SimWorld): void {
  world.half = 2;
  world.clock = 0;
  world.attackDir = { home: world.attackDir.away, away: world.attackDir.home };
  resetToKickoff(world, other(world.kickoffSide));
  world.banner = 'Second half';
  world.events.push({ type: 'kickoff' });
}

/** Match minute shown on the HUD: each half maps onto 45 minutes. */
export function matchMinute(world: SimWorld): number {
  const progress = clamp(world.clock / world.config.halfLength, 0, 1);
  return Math.floor((world.half - 1) * 45 + progress * 45);
}
