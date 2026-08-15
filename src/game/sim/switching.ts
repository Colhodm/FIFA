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
export function rankSwitchCandidates(
  world: SimWorld,
  allowKeeper = true,
  /**
   * Whether to weigh being goal-side. Callers must pass this explicitly at a turnover:
   * `world.possession` is not updated until after the switch is made, so reading it here
   * reported "we are still attacking" at the exact moment the ball was lost, and handed the
   * player whichever forward happened to be nearest instead of a defender getting back.
   */
  defendingOverride?: boolean,
): SwitchCandidate[] {
  const w = world.tuning.switching;
  const human = world.config.humanSide;
  const ball = ballPos2(world);
  const ahead = predictedBall(world, w.predictSeconds);
  const own = ownGoalCenter(world, human);
  const defending = defendingOverride ?? (world.possession !== null && world.possession !== human);

  const outfield = world.players.filter(
    (p) => p.side === human && !p.sentOff && p.id !== world.activeId && p.role !== 'GK',
  );

  // The keeper is only a legitimate pick inside his own area with nobody else near the ball.
  const keeper = world.players.find((p) => p.side === human && p.role === 'GK' && !p.sentOff);
  const pool = [...outfield];
  if (
    allowKeeper &&
    keeper &&
    keeper.id !== world.activeId &&
    inOwnPenaltyArea(world, human, ball)
  ) {
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
    .map((p) => score(world, p, ball, ahead, toGoal, defending))
    .sort((a, b) => a.score - b.score);
}

function score(
  world: SimWorld,
  p: SimPlayer,
  ball: Vec2,
  ahead: Vec2,
  toGoal: Vec2,
  defending: boolean,
): SwitchCandidate {
  const w = world.tuning.switching;
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
    score: w.predictedDistance * predicted + w.currentDistance * current + w.anglePenalty * angle,
  };
}

/** How well placed one specific player is — used to judge whether a handover is worth making. */
export function scoreForPlayer(world: SimWorld, p: SimPlayer, defending: boolean): number {
  const ball = ballPos2(world);
  const ahead = predictedBall(world, world.tuning.switching.predictSeconds);
  const toGoal = normalize(sub(ownGoalCenter(world, p.side), ball));
  return score(world, p, ball, ahead, toGoal, defending).score;
}

/** Re-evaluated on this cadence while defending, rather than only when the ball changes hands. */
const DEFENSIVE_REVIEW = 0.45;
/** The new man must be this much better placed before control is taken off you. */
const HANDOVER_MARGIN = 0.68;

/**
 * Continuous switching while the opposition has the ball.
 *
 * Every other switch decision hangs off "a new player took possession". That is fine going
 * forward, but defending is precisely the case where possession does *not* change: an opponent
 * carries the ball for several seconds, the attack develops past your man, and because no
 * holder change ever fires you stay glued to whoever happened to be nearest when the ball was
 * lost. The camera frames on the active player, so a stale pick drags the shot away from the
 * play as well.
 */
export function reviewDefensiveSwitch(world: SimWorld): void {
  const human = world.config.humanSide;
  if (world.possession === null || world.possession === human) return;
  if (manualSwitchHeld(world)) return;
  const s = world.switching;
  if (s.sinceAuto < DEFENSIVE_REVIEW) return;
  s.sinceAuto = 0;

  const active = world.players.find((p) => p.id === world.activeId);
  if (!active || active.sentOff) return;
  // Never yank a man out of a committed action.
  if (active.kickCooldown > 0 || active.skillTimer > 0.15 || active.anim === 'slide') return;

  const best = rankSwitchCandidates(world, false, true)[0];
  if (!best) return;
  // Hysteresis: a marginally better candidate is not worth the disorientation of a handover.
  if (best.score < scoreForPlayer(world, active, true) * HANDOVER_MARGIN) {
    world.activeId = best.id;
  }
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
  world.switching.sinceAuto += dt;
}
