import { BALL_MASS, BALL_RADIUS, HALF_LENGTH, KICK_COOLDOWN } from '../constants';
import type { TeamSide } from '../types';
import { clamp, dist, distToSegment, dot, normalize, sub, type Vec2 } from './math';
import type { SimPlayer, SimWorld } from './state';

export const goalCenter = (world: SimWorld, side: TeamSide): Vec2 => ({
  x: HALF_LENGTH * world.attackDir[side],
  z: 0,
});

export const ownGoalCenter = (world: SimWorld, side: TeamSide): Vec2 => ({
  x: -HALF_LENGTH * world.attackDir[side],
  z: 0,
});

export const ballPos2 = (world: SimWorld): Vec2 => ({
  x: world.ball.pos.x,
  z: world.ball.pos.z,
});

/**
 * Applies an impulse at the contact point on the ball surface, factoring in the kicker's
 * momentum. The contact offset is what makes the ball pick up roll instead of sliding.
 * `curl` is side-spin in rad/s: positive bends the ball to the kicker's right.
 */
export function applyKick(
  world: SimWorld,
  player: SimPlayer,
  dir: Vec2,
  speed: number,
  lift: number,
  curl = 0,
): void {
  const d = normalize(dir);
  const ball = world.ball;
  const target = {
    x: d.x * speed + player.vel.x * 0.3,
    y: lift,
    z: d.z * speed + player.vel.z * 0.3,
  };
  world.commands.push({
    type: 'impulse',
    impulse: {
      x: (target.x - ball.vel.x) * BALL_MASS,
      y: (target.y - ball.vel.y) * BALL_MASS,
      z: (target.z - ball.vel.z) * BALL_MASS,
    },
    point: {
      x: ball.pos.x - d.x * BALL_RADIUS,
      y: ball.pos.y - (lift > 0 ? BALL_RADIUS * 0.6 : 0),
      z: ball.pos.z - d.z * BALL_RADIUS,
    },
  });
  ball.vel = target;
  ball.spin = { x: 0, y: curl, z: 0 };
  player.kickCooldown = KICK_COOLDOWN;
  player.anim = 'kick';
  player.animTimer = 0.3;
  world.controllerId = null;
  world.lastTouch = { side: player.side, playerId: player.id };
  world.possession = player.side;
  // Resolved at the end of the tick so the offside law never has to import the rules here.
  world.pendingKickId = player.id;
}

/** Curl a shot or cross needs to bend from `dir` towards `target`, in rad/s of side spin. */
export function curlToward(from: Vec2, dir: Vec2, target: Vec2, strength = 1): number {
  const to = normalize(sub(target, from));
  const d = normalize(dir);
  // Cross product sign tells us which way the ball has to bend to find the target.
  const cross = d.x * to.z - d.z * to.x;
  return clamp(-cross * 26 * strength, -22, 22);
}

/** How free a straight pass from `from` to `to` is: 0 = intercepted, 1 = wide open. */
export function laneOpenness(world: SimWorld, from: Vec2, to: Vec2, side: TeamSide): number {
  let worst = 1;
  for (const opp of world.players) {
    if (opp.side === side || opp.sentOff) continue;
    const d = distToSegment(opp.pos, from, to);
    worst = Math.min(worst, clamp(d / 4.5, 0, 1));
  }
  return worst;
}

/**
 * Position of the second-last defender in attacking coordinates (x * attackDir): a receiver
 * beyond this when the ball is played is offside, so the AI avoids passing there.
 */
export function offsideLine(world: SimWorld, side: TeamSide): number {
  const attack = world.attackDir[side];
  const xs = world.players
    .filter((p) => p.side !== side && !p.sentOff)
    .map((p) => p.pos.x * attack)
    .sort((a, b) => b - a);
  return Math.max(xs[1] ?? -HALF_LENGTH, 0);
}

export interface PassOption {
  target: SimPlayer;
  /** Lead position accounting for the receiver's run. */
  spot: Vec2;
  score: number;
}

/**
 * Ranks teammates as pass receivers. `prefDir` biases towards where the passer is aiming
 * (the human's stick/keys) so manual passes feel directed rather than automatic.
 */
export function bestPass(world: SimWorld, passer: SimPlayer, prefDir?: Vec2): PassOption | null {
  const attack = world.attackDir[passer.side];
  const line = world.offsideActive ? offsideLine(world, passer.side) : Infinity;
  let best: PassOption | null = null;
  for (const mate of world.players) {
    if (mate.side !== passer.side || mate.id === passer.id || mate.sentOff) continue;
    const d = dist(passer.pos, mate.pos);
    if (d < 3 || d > 42) continue;
    const travel = clamp(d / 16, 0.15, 1.2);
    const spot = { x: mate.pos.x + mate.vel.x * travel, z: mate.pos.z + mate.vel.z * travel };
    const open = laneOpenness(world, passer.pos, spot, passer.side);
    const forward = ((spot.x - passer.pos.x) * attack) / 40;
    const toMate = normalize(sub(spot, passer.pos));
    const aim = prefDir ? dot(toMate, normalize(prefDir)) : 0;
    const keeperPenalty = mate.role === 'GK' ? -0.6 : 0;
    const offsidePenalty = mate.pos.x * attack > line + 0.4 ? -3 : 0;
    const score =
      offsidePenalty +
      open * 1.6 +
      forward * 1.1 +
      aim * (prefDir ? 1.5 : 0) -
      d / 90 +
      keeperPenalty +
      (mate.passing / 100) * 0.15;
    if (!best || score > best.score) best = { target: mate, spot, score };
  }
  return best;
}

/**
 * Through ball target: the space in front of a teammate's run, held just short of the last
 * defender so the pass splits the line instead of running through to the keeper.
 */
export function bestThroughBall(
  world: SimWorld,
  passer: SimPlayer,
  prefDir?: Vec2,
): PassOption | null {
  const attack = world.attackDir[passer.side];
  const goal = goalCenter(world, passer.side);
  const line = world.offsideActive ? offsideLine(world, passer.side) : Infinity;
  let best: PassOption | null = null;
  for (const mate of world.players) {
    if (mate.side !== passer.side || mate.id === passer.id || mate.role === 'GK') continue;
    if (mate.sentOff) continue;
    // A runner already beyond the last man is offside the instant the ball is played.
    if (mate.pos.x * attack > line + 0.4) continue;
    // Only play forwards, into a runner ahead of the passer.
    const ahead = (mate.pos.x - passer.pos.x) * attack;
    if (ahead < -2) continue;
    const run = normalize({ x: attack, z: mate.vel.z * 0.15 });
    const lead = clamp(6 + mate.pace / 8 + ahead * 0.25, 6, 20);
    const spot = clampInPlay(
      { x: mate.pos.x + run.x * lead, z: mate.pos.z + run.z * lead },
      attack,
    );
    const open = laneOpenness(world, passer.pos, spot, passer.side);
    const toSpot = normalize(sub(spot, passer.pos));
    const aim = prefDir ? dot(toSpot, normalize(prefDir)) : 0;
    const goalGain = (dist(passer.pos, goal) - dist(spot, goal)) / 40;
    const score =
      open * 1.5 + goalGain * 1.6 + aim * (prefDir ? 1.2 : 0) - dist(spot, mate.pos) / 60;
    if (!best || score > best.score) best = { target: mate, spot, score };
  }
  return best;
}

/** Cross target: a teammate attacking the box, or the penalty spot if nobody has arrived yet. */
export function bestCross(world: SimWorld, passer: SimPlayer): PassOption | null {
  const attack = world.attackDir[passer.side];
  const goal = goalCenter(world, passer.side);
  let best: PassOption | null = null;
  for (const mate of world.players) {
    if (mate.side !== passer.side || mate.id === passer.id || mate.role === 'GK') continue;
    if (mate.sentOff) continue;
    const travel = 0.9;
    const spot = { x: mate.pos.x + mate.vel.x * travel, z: mate.pos.z + mate.vel.z * travel };
    const d = dist(passer.pos, spot);
    if (d < 6 || d > 48) continue;
    // Reward bodies in the danger zone: central, close to goal, ahead of the crosser.
    const boxDist = dist(spot, goal);
    const central = clamp(1 - Math.abs(spot.z) / 18, 0, 1);
    const forward = ((spot.x - passer.pos.x) * attack) / 30;
    const score = clamp(1 - (boxDist - 6) / 24, 0, 1) * 1.8 + central * 1.2 + forward;
    if (!best || score > best.score) best = { target: mate, spot, score };
  }
  return best;
}

const clampInPlay = (p: Vec2, attack: 1 | -1): Vec2 => ({
  // Keep through balls inside the field of play and out of the keeper's arms.
  x: attack > 0 ? Math.min(p.x, HALF_LENGTH - 4) : Math.max(p.x, -HALF_LENGTH + 4),
  z: clamp(p.z, -32, 32),
});

/** Straight-line quality of a shot from `from`: combines distance and angle to goal. */
export function shotQuality(world: SimWorld, from: Vec2, side: TeamSide): number {
  const goal = goalCenter(world, side);
  const d = dist(from, goal);
  if (d > 34) return 0;
  const angle = Math.abs(Math.atan2(from.z - goal.z, Math.abs(from.x - goal.x)));
  const distScore = clamp(1 - (d - 6) / 28, 0, 1);
  const angleScore = clamp(1 - angle / 1.05, 0, 1);
  const lane = laneOpenness(world, from, goal, side);
  return distScore * angleScore * (0.45 + lane * 0.55);
}
