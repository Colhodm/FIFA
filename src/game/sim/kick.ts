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
 */
export function applyKick(
  world: SimWorld,
  player: SimPlayer,
  dir: Vec2,
  speed: number,
  lift: number,
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
  player.kickCooldown = KICK_COOLDOWN;
  world.controllerId = null;
  world.lastTouch = { side: player.side, playerId: player.id };
  world.possession = player.side;
}

/** How free a straight pass from `from` to `to` is: 0 = intercepted, 1 = wide open. */
export function laneOpenness(world: SimWorld, from: Vec2, to: Vec2, side: TeamSide): number {
  let worst = 1;
  for (const opp of world.players) {
    if (opp.side === side) continue;
    const d = distToSegment(opp.pos, from, to);
    worst = Math.min(worst, clamp(d / 4.5, 0, 1));
  }
  return worst;
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
  let best: PassOption | null = null;
  for (const mate of world.players) {
    if (mate.side !== passer.side || mate.id === passer.id) continue;
    const d = dist(passer.pos, mate.pos);
    if (d < 3 || d > 42) continue;
    const travel = clamp(d / 16, 0.15, 1.2);
    const spot = { x: mate.pos.x + mate.vel.x * travel, z: mate.pos.z + mate.vel.z * travel };
    const open = laneOpenness(world, passer.pos, spot, passer.side);
    const forward = ((spot.x - passer.pos.x) * attack) / 40;
    const toMate = normalize(sub(spot, passer.pos));
    const aim = prefDir ? dot(toMate, normalize(prefDir)) : 0;
    const keeperPenalty = mate.role === 'GK' ? -0.6 : 0;
    const score =
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
