import { BALL_RADIUS, GOAL_HEIGHT, HALF_GOAL_WIDTH, HALF_LENGTH } from '../constants';
import type { ShotTuning } from '../tuning';
import { applyKickVelocity } from './kick';
import { clamp, dist, type Vec2, type Vec3 } from './math';
import { DEFAULT_FLIGHT, solveLaunch } from './ballistics';
import type { SimPlayer, SimWorld } from './state';

/** How the ball is struck, which fixes the spin and roughly fixes the flight. */
export type ShotStyle = 'driven' | 'finesse' | 'chip';

export interface ShotContext {
  style: ShotStyle;
  /** 0..1 charge from the hold. */
  charge: number;
  /** Where the player is asking for it to go, in pitch space. Null aims at goal. */
  aim: Vec2 | null;
  /** Distance to the nearest opponent, so pressure can spoil the strike. */
  pressure: number;
}

/**
 * Picks the point on the goal plane the shot is *meant* to hit, then perturbs it.
 *
 * The perturbation is the whole skill model. Its spread grows with everything that makes a shot
 * hard — distance, angle, pressure, a body shape that is not set, and leaning on the ball past
 * the point where extra power buys anything — and shrinks with the striker's finishing.
 *
 * Crucially, a miss is nudged to a *believable* place. A footballer who mishits from 18 yards
 * puts it a yard wide or over the bar; he does not put it into the corner flag. Errors that
 * would land absurdly are pulled back to just outside the frame.
 */
export function pickTarget(
  world: SimWorld,
  p: SimPlayer,
  ctx: ShotContext,
  tuning: ShotTuning,
): { z: number; y: number; onTarget: boolean } {
  const goalX = HALF_LENGTH * world.attackDir[p.side];
  const d = dist(p.pos, { x: goalX, z: 0 });

  // Intended placement: the player's aim if he gave one, otherwise the corner the keeper has
  // left open. Aim is expressed as the z on the goal line.
  const keeper = world.players.find((o) => o.side !== p.side && o.role === 'GK');
  const away = keeper && Math.abs(keeper.pos.z) > 0.15 ? -Math.sign(keeper.pos.z) : 0;
  const side = away || (world.rand() < 0.5 ? -1 : 1);

  let wantZ: number;
  if (ctx.aim) {
    // Project the aim direction onto the goal plane.
    const toPlane = goalX - p.pos.x;
    const scale = Math.abs(ctx.aim.x) < 1e-4 ? 0 : toPlane / ctx.aim.x;
    wantZ = scale > 0 ? p.pos.z + ctx.aim.z * scale : p.pos.z;
    // Keep a manual aim inside the frame; the error model decides if it stays there.
    wantZ = clamp(wantZ, -(HALF_GOAL_WIDTH - 0.35), HALF_GOAL_WIDTH - 0.35);
  } else {
    // Closer in, a finisher picks his corner precisely; from distance he aims more generally.
    const precision = clamp(1 - d / 30, 0, 1);
    wantZ = side * (HALF_GOAL_WIDTH - 0.35) * (0.68 + precision * 0.22 + world.rand() * 0.1);
  }

  // Height: driven shots stay down, chips are lifted over the keeper.
  const wantY =
    ctx.style === 'chip'
      ? GOAL_HEIGHT * 0.72
      : ctx.style === 'finesse'
        ? 0.35 + world.rand() * 0.75
        : 0.25 + world.rand() * 0.5;

  // Spread, in metres at the goal plane.
  const overcharge = Math.max(0, ctx.charge - tuning.overchargeThreshold);
  const angle = Math.abs(Math.atan2(p.pos.z, Math.abs(goalX - p.pos.x)));
  const spread =
    tuning.baseSpread *
    (1 + d / tuning.distanceSpreadMetres) *
    (1 + angle * tuning.angleSpread) *
    (1 + overcharge * tuning.overchargeSpread) *
    (1 + clamp(1 - ctx.pressure / 4, 0, 1) * tuning.pressureSpread) *
    (1.35 - p.shooting / 130);

  const gauss = () => (world.rand() + world.rand() + world.rand() - 1.5) / 1.5;
  let z = wantZ + gauss() * spread;
  let y = wantY + gauss() * spread * 0.55;

  // Pull an absurd miss back to a believable one: just past the post, or just over the bar.
  const postGap = Math.abs(z) - HALF_GOAL_WIDTH;
  if (postGap > 0)
    z = Math.sign(z) * (HALF_GOAL_WIDTH + Math.min(postGap, 0.3 + world.rand() * 1.1));
  if (y > GOAL_HEIGHT) y = GOAL_HEIGHT + Math.min(y - GOAL_HEIGHT, 0.25 + world.rand() * 1.2);
  y = Math.max(BALL_RADIUS, y);

  const onTarget = Math.abs(z) < HALF_GOAL_WIDTH && y < GOAL_HEIGHT;
  return { z, y, onTarget };
}

/**
 * Sidespin for each style, in the units the frame loop's Magnus term expects: the lateral
 * acceleration it produces is `MAGNUS * spin * speed`, so with MAGNUS at 0.42 a spin of 1.0
 * bends a 25 m/s shot by roughly two metres over eighteen yards. Values an order of magnitude
 * larger — which is what a "rad/s" reading of this field suggests — corkscrew the ball.
 */
function spinFor(
  world: SimWorld,
  p: SimPlayer,
  ctx: ShotContext,
  targetZ: number,
  curl: number,
): number {
  if (ctx.style === 'finesse') {
    // Wrap the foot around it, bending back towards the middle of the goal.
    return -Math.sign(targetZ || 1) * curl * (0.7 + (p.shooting / 100) * 0.5);
  }
  if (ctx.style === 'chip') return 0;
  // A driven ball is close to spinless, which is what gives it its late wobble.
  return (world.rand() * 2 - 1) * curl * 0.12;
}

/**
 * Plays a shot: choose a target, solve the launch that reaches it under the real flight model,
 * then strike the ball with that exact velocity so the flight is fully physical and can still be
 * blocked, deflected or saved.
 */
export function strike(
  world: SimWorld,
  p: SimPlayer,
  ctx: ShotContext,
  tuning: ShotTuning,
): { targetZ: number; targetY: number; speed: number; solved: boolean } {
  const goalX = HALF_LENGTH * world.attackDir[p.side];
  const target = pickTarget(world, p, ctx, tuning);
  const spin = spinFor(world, p, ctx, target.z, tuning.curlSpin);

  // Power from the charge, then the style's own character on top.
  const base =
    tuning.maxSpeed *
    (tuning.minPowerFraction +
      (1 - tuning.minPowerFraction) * Math.pow(clamp(ctx.charge, 0, 1), 1.1));
  const speed = base * (ctx.style === 'chip' ? 0.55 : ctx.style === 'finesse' ? 0.85 : 1);

  const from: Vec3 = {
    x: world.ball.pos.x,
    y: Math.max(world.ball.pos.y, BALL_RADIUS),
    z: world.ball.pos.z,
  };
  const solution = solveLaunch(from, target.z, target.y, goalX, speed, spin, DEFAULT_FLIGHT);

  if (solution) {
    applyKickVelocity(world, p, solution.vel, spin, 'shot');
    return { targetZ: target.z, targetY: target.y, speed, solved: true };
  }

  // No solution at this pace — usually a tap from far out. Strike it straight at the target on
  // the low arc that carries furthest, rather than dropping the input or firing it anywhere.
  const dx = goalX - from.x;
  const dz = target.z - from.z;
  const flat = Math.hypot(dx, dz) || 1;
  const el = Math.min(
    0.5,
    Math.atan2(
      Math.max(0, target.y - from.y) +
        ((DEFAULT_FLIGHT.gravity * flat) / (2 * speed * speed)) * flat,
      flat,
    ),
  );
  const horizontal = Math.cos(el) * speed;
  applyKickVelocity(
    world,
    p,
    { x: (dx / flat) * horizontal, y: Math.sin(el) * speed, z: (dz / flat) * horizontal },
    spin,
    'shot',
  );
  return { targetZ: target.z, targetY: target.y, speed, solved: false };
}
