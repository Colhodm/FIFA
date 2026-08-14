import { PENALTY_BOX_DEPTH, PENALTY_BOX_WIDTH } from '../constants';
import { ballPos2, ownGoalCenter } from './kick';
import { dist, normalize, sub, type Vec2 } from './math';
import type { SimPlayer, SimWorld } from './state';

/**
 * How much ground being completely the wrong side of the ball is worth. The distance terms are
 * in metres, so the angle penalty is expressed in metres too rather than in arbitrary units.
 */
const ANGLE_PENALTY_METRES = 25;

/** A player must be this much closer than the keeper before the keeper is even considered. */
const KEEPER_MARGIN = 5;

export interface SwitchCandidate {
  id: number;
  name: string;
  score: number;
  predicted: number;
  current: number;
  angle: number;
}

/** Where the ball will be shortly — switch to where play is going, not where it has been. */
export function predictedBall(world: SimWorld, seconds: number): Vec2 {
  const ball = ballPos2(world);
  return { x: ball.x + world.ball.vel.x * seconds, z: ball.z + world.ball.vel.z * seconds };
}

const inOwnPenaltyArea = (world: SimWorld, side: SimPlayer['side'], p: Vec2): boolean => {
  const own = ownGoalCenter(world, side);
  const towardsCentre = Math.sign(-own.x) || 1;
  const depth = (p.x - own.x) * towardsCentre;
  return depth >= 0 && depth <= PENALTY_BOX_DEPTH && Math.abs(p.z) <= PENALTY_BOX_WIDTH / 2;
};

/**
 * Ranks the human's outfield players as switch targets, best (lowest score) first.
 *
 * `score = w1*d(predicted) + w2*d(current) + w3*angle`, where the angle term punishes a player
 * who is the wrong side of the ball while defending. The currently controlled player is never a
 * candidate, and the keeper only becomes one inside his own box when nobody else is close.
 */
export function rankSwitchCandidates(world: SimWorld): SwitchCandidate[] {
  const w = world.tuning.switching;
  const human = world.config.humanSide;
  const ball = ballPos2(world);
  const ahead = predictedBall(world, w.predictSeconds);
  const own = ownGoalCenter(world, human);
  const defending = world.possession !== null && world.possession !== human;

  const outfield = world.players.filter(
    (p) => p.side === human && !p.sentOff && p.id !== world.activeId && p.role !== 'GK',
  );

  // The keeper is only a legitimate pick inside his own area with nobody else near the ball.
  const keeper = world.players.find((p) => p.side === human && p.role === 'GK' && !p.sentOff);
  const pool = [...outfield];
  if (keeper && keeper.id !== world.activeId && inOwnPenaltyArea(world, human, ball)) {
    const nearestOutfield = outfield.reduce(
      (best, p) => Math.min(best, dist(p.pos, ball)),
      Infinity,
    );
    if (dist(keeper.pos, ball) + KEEPER_MARGIN < nearestOutfield) pool.push(keeper);
  }

  // Angle at the ball between "towards this player" and "towards my own goal": zero when the
  // player is standing directly on the covering line.
  const toGoal = normalize(sub(own, ball));

  return pool
    .map((p) => {
      const toPlayer = normalize(sub(p.pos, ball));
      const cos = Math.max(-1, Math.min(1, toPlayer.x * toGoal.x + toPlayer.z * toGoal.z));
      const angle = defending ? (Math.acos(cos) / Math.PI) * ANGLE_PENALTY_METRES : 0;
      const predicted = dist(p.pos, ahead);
      const current = dist(p.pos, ball);
      return {
        id: p.id,
        name: p.name,
        predicted,
        current,
        angle,
        score:
          w.predictedDistance * predicted + w.currentDistance * current + w.anglePenalty * angle,
      };
    })
    .sort((a, b) => a.score - b.score);
}

/** Ignore a repeated switch press inside this window (hardware key repeat, not intent). */
const DEBOUNCE = 0.1;

/**
 * Handles a manual switch press. The first press ranks the squad and takes the best candidate;
 * further presses inside the cycle window walk down *that* ranking rather than re-ranking, which
 * is what stops it feeling like the game keeps handing you the same player.
 */
export function requestSwitch(world: SimWorld): boolean {
  const s = world.switching;
  if (s.sincePress < DEBOUNCE) return false;

  const cycling = s.sincePress < world.tuning.switching.cycleWindowSeconds && s.ranking.length > 0;
  if (!cycling) {
    s.ranking = rankSwitchCandidates(world).map((c) => c.id);
    s.cursor = 0;
  } else {
    s.cursor += 1;
  }
  s.sincePress = 0;

  // Skip anyone who has since been sent off or become the active man.
  for (let i = 0; i < s.ranking.length; i++) {
    const id = s.ranking[(s.cursor + i) % s.ranking.length];
    const player = world.players.find((p) => p.id === id);
    if (!player || player.sentOff || id === world.activeId) continue;
    s.cursor = (s.cursor + i) % s.ranking.length;
    world.activeId = id;
    s.sinceManual = 0;
    return true;
  }
  return false;
}

/** True while a manual switch should win over the game's own auto-switching. */
export const manualSwitchHeld = (world: SimWorld): boolean =>
  world.switching.sinceManual < world.tuning.switching.manualHoldSeconds;

export function advanceSwitchTimers(world: SimWorld, dt: number): void {
  world.switching.sincePress += dt;
  world.switching.sinceManual += dt;
}
