import {
  HALF_GOAL_WIDTH,
  HALF_LENGTH,
  HALF_WIDTH,
  MAX_PASS_POWER,
  MAX_SHOT_POWER,
  MIN_PASS_POWER,
  MIN_SHOT_POWER,
} from '../constants';
import { applyKick, ballPos2, bestPass, goalCenter, ownGoalCenter, shotQuality } from './kick';
import { clamp, dist, normalize, sub, type Vec2 } from './math';
import { slotToPitch, type DifficultyProfile, type SimPlayer, type SimWorld } from './state';

const EDGE = 1.5;

const clampToPitch = (p: Vec2): Vec2 => ({
  x: clamp(p.x, -HALF_LENGTH + EDGE, HALF_LENGTH - EDGE),
  z: clamp(p.z, -HALF_WIDTH + EDGE, HALF_WIDTH - EDGE),
});

/** Nearest player of a side to a point, optionally skipping the goalkeeper. */
export function nearestOf(
  world: SimWorld,
  point: Vec2,
  side: SimPlayer['side'],
  skipKeeper = true,
  exclude = -1,
): SimPlayer | null {
  let best: SimPlayer | null = null;
  let bestD = Infinity;
  for (const p of world.players) {
    if (p.side !== side || p.id === exclude) continue;
    if (skipKeeper && p.role === 'GK') continue;
    const d = dist(p.pos, point);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

export function nearestOpponentDistance(world: SimWorld, p: SimPlayer): number {
  let best = Infinity;
  for (const o of world.players) {
    if (o.side === p.side) continue;
    best = Math.min(best, dist(o.pos, p.pos));
  }
  return best;
}

/** Where the ball will be shortly — used so chasers cut it off instead of trailing it. */
function interceptPoint(world: SimWorld, lead = 0.35): Vec2 {
  return {
    x: world.ball.pos.x + world.ball.vel.x * lead,
    z: world.ball.pos.z + world.ball.vel.z * lead,
  };
}

/** Formation shape position for a player, shifted by ball position and phase of play. */
function shapeTarget(world: SimWorld, p: SimPlayer): Vec2 {
  const dir = world.attackDir[p.side];
  const base = slotToPitch(p.slot, dir);
  const ball = ballPos2(world);
  const attacking = world.possession === p.side;
  const push = attacking ? 9 : -4;
  const line = p.slotRole === 'DF' ? 0.5 : p.slotRole === 'FW' ? 1.1 : 0.8;
  return clampToPitch({
    x: base.x + clamp(ball.x * 0.45, -20, 20) + push * dir * line,
    z: base.z + clamp((ball.z - base.z) * 0.35, -13, 13),
  });
}

function markTarget(world: SimWorld, p: SimPlayer, profile: DifficultyProfile): Vec2 | null {
  const own = ownGoalCenter(world, p.side);
  let best: SimPlayer | null = null;
  let bestD = Infinity;
  for (const o of world.players) {
    if (o.side === p.side || o.role === 'GK') continue;
    const d = dist(o.pos, p.pos);
    if (d < bestD && d < 22) {
      bestD = d;
      best = o;
    }
  }
  if (!best) return null;
  const goalSide = normalize(sub(own, best.pos));
  const gap = 1.1 + (1 - profile.marking) * 3.2;
  return clampToPitch({ x: best.pos.x + goalSide.x * gap, z: best.pos.z + goalSide.z * gap });
}

function setIntent(p: SimPlayer, target: Vec2, sprint: boolean): void {
  const to = sub(target, p.pos);
  const d = Math.hypot(to.x, to.z);
  // Ease off near the target so players settle instead of jittering.
  const throttle = clamp(d / 2.5, 0, 1);
  const n = normalize(to);
  p.intent = { x: n.x * throttle, z: n.z * throttle };
  p.intentSprint = sprint && d > 5;
}

/** Off-ball decision for one AI player. Called on the reaction-time cadence. */
export function decideOffBall(world: SimWorld, p: SimPlayer, profile: DifficultyProfile): void {
  if (p.role === 'GK') {
    decideKeeper(world, p, profile);
    return;
  }

  const ball = ballPos2(world);
  const teamHasBall = world.possession === p.side;
  const chaser = nearestOf(world, ball, p.side);
  const secondChaser = nearestOf(world, ball, p.side, true, chaser?.id ?? -1);
  const wantsSprint = p.stamina > 0.25 && world.rand() < profile.sprintBias;

  if (!teamHasBall) {
    if (chaser?.id === p.id) {
      setIntent(p, clampToPitch(interceptPoint(world)), p.stamina > 0.15);
      return;
    }
    if (secondChaser?.id === p.id) {
      const own = ownGoalCenter(world, p.side);
      const toGoal = normalize(sub(own, ball));
      setIntent(
        p,
        clampToPitch({ x: ball.x + toGoal.x * 6, z: ball.z + toGoal.z * 6 }),
        wantsSprint,
      );
      return;
    }
    const mark = markTarget(world, p, profile);
    const shape = shapeTarget(world, p);
    const w = profile.marking * 0.75;
    const target = mark
      ? { x: shape.x * (1 - w) + mark.x * w, z: shape.z * (1 - w) + mark.z * w }
      : shape;
    setIntent(p, target, wantsSprint && dist(p.pos, target) > 9);
    return;
  }

  // In possession without the ball: support the carrier and stretch the defence.
  const carrier = world.players.find((c) => c.id === world.controllerId);
  const shape = shapeTarget(world, p);
  if (carrier && carrier.id !== p.id && dist(carrier.pos, p.pos) < 14) {
    const away = normalize(sub(p.pos, carrier.pos));
    const support = clampToPitch({
      x: p.pos.x + away.x * 5 + world.attackDir[p.side] * 3,
      z: p.pos.z + away.z * 5,
    });
    setIntent(p, { x: (shape.x + support.x) / 2, z: (shape.z + support.z) / 2 }, wantsSprint);
    return;
  }
  setIntent(p, shape, wantsSprint && dist(p.pos, shape) > 9);
}

function decideKeeper(world: SimWorld, p: SimPlayer, profile: DifficultyProfile): void {
  const own = ownGoalCenter(world, p.side);
  const ball = ballPos2(world);
  const toBall = normalize(sub(ball, own));
  const ballDist = dist(ball, own);
  const advance = clamp(ballDist * 0.14, 0.5, 3.5) * (0.7 + profile.marking * 0.4);
  const target = {
    x: own.x + toBall.x * advance,
    z: clamp(own.z + toBall.z * advance * 1.6, -HALF_GOAL_WIDTH - 2.2, HALF_GOAL_WIDTH + 2.2),
  };

  // Ball travelling at goal: cover where it will cross the line rather than chasing it.
  const closing = Math.abs(world.ball.vel.x);
  const towardsGoal = (own.x - world.ball.pos.x) * world.ball.vel.x > 0;
  if (towardsGoal && closing > 5) {
    const eta = Math.abs(own.x - world.ball.pos.x) / closing;
    if (eta < 2.5) {
      // Keepers read the shot imperfectly; sharper difficulties guess closer to the truth.
      const misread = (1.1 + closing * 0.09) * (1.35 - profile.marking);
      // Derived from the shot's own velocity so the error stays stable during its flight.
      const guess = Math.sin(world.ball.vel.x * 3.1 + world.ball.vel.z * 7.7);
      const crossZ = world.ball.pos.z + world.ball.vel.z * eta + guess * misread;
      setIntent(
        p,
        {
          x: own.x + toBall.x * Math.min(advance, 1.2),
          z: clamp(crossZ, -HALF_GOAL_WIDTH - 0.5, HALF_GOAL_WIDTH + 0.5),
        },
        true,
      );
      return;
    }
  }
  // Rush out to smother a loose ball inside the box.
  const rush = ballDist < 14 && world.possession !== p.side && world.ball.pos.y < 1.6;
  setIntent(p, rush && ballDist < 9 ? ball : target, rush);
}

/** Decision for the AI player currently in control of the ball. Returns true if it kicked. */
export function decideOnBall(world: SimWorld, p: SimPlayer, profile: DifficultyProfile): boolean {
  const goal = goalCenter(world, p.side);
  const pressure = nearestOpponentDistance(world, p);

  if (p.role === 'GK') {
    const pass = bestPass(world, p, sub(goal, p.pos));
    const upfield = normalize(sub(goal, p.pos));
    if (pass && pass.score > 0.7) {
      kickPass(world, p, pass.spot, profile);
    } else {
      applyKick(world, p, upfield, 22, 5);
      world.events.push({ type: 'kick', side: p.side, intensity: 0.9 });
    }
    return true;
  }

  const quality = shotQuality(world, p.pos, p.side);
  const shootBar = 0.34 + (1 - profile.shotAccuracy) * 0.2;
  // Inside the box with any sort of angle, take the shot rather than walking it in.
  const goalDist = dist(p.pos, goal);
  const pointBlank = goalDist < 16 && Math.abs(p.pos.z) < 14 && pressure > 1.6;
  if (pointBlank || quality > shootBar) {
    shoot(world, p, profile, quality);
    return true;
  }

  const pass = bestPass(world, p);
  if (pass && (pressure < 3.4 || pass.score > 1.5) && pass.score > 0.55) {
    kickPass(world, p, pass.spot, profile);
    return true;
  }

  // Carry the ball at goal, steering around the nearest defender.
  const toGoal = normalize(sub(goal, p.pos));
  let steer = toGoal;
  const defender = nearestOf(world, p.pos, p.side === 'home' ? 'away' : 'home');
  if (defender && dist(defender.pos, p.pos) < 6) {
    const away = normalize(sub(p.pos, defender.pos));
    steer = normalize({ x: toGoal.x + away.x * 1.3, z: toGoal.z + away.z * 1.3 });
  }
  p.intent = steer;
  p.intentSprint = p.stamina > 0.2 && world.rand() < profile.sprintBias;
  return false;
}

export function shoot(
  world: SimWorld,
  p: SimPlayer,
  profile: DifficultyProfile,
  quality: number,
  powerScale = 1,
): void {
  const goal = goalCenter(world, p.side);
  const d = dist(p.pos, goal);
  // Aim for the corner the keeper has left open.
  const keeper = world.players.find((o) => o.side !== p.side && o.role === 'GK');
  const away = keeper && Math.abs(keeper.pos.z) > 0.15 ? -Math.sign(keeper.pos.z) : 0;
  const placement =
    (away || (world.rand() < 0.5 ? -1 : 1)) *
    (HALF_GOAL_WIDTH - 0.5) *
    (0.55 + world.rand() * 0.45);
  const errorScale = (1 - profile.shotAccuracy) * (1 - quality * 0.5) * (2 + d * 0.12);
  const aim: Vec2 = {
    x: goal.x,
    z: placement * profile.shotAccuracy + (world.rand() * 2 - 1) * errorScale,
  };
  const dir = normalize(sub(aim, p.pos));
  const power =
    clamp(MIN_SHOT_POWER + d * 0.62, MIN_SHOT_POWER, MAX_SHOT_POWER) *
    (0.82 + p.shooting / 320) *
    powerScale;
  applyKick(world, p, dir, power, clamp(d * 0.075, 0.35, 2.6));
  world.shots[p.side] += 1;
  world.events.push({ type: 'shot', side: p.side, intensity: clamp(power / MAX_SHOT_POWER, 0, 1) });
}

export function kickPass(
  world: SimWorld,
  p: SimPlayer,
  spot: Vec2,
  profile: DifficultyProfile,
  powerScale = 1,
): void {
  const d = dist(p.pos, spot);
  const skill = profile.passAccuracy * (0.75 + p.passing / 400);
  const spread = (1 - clamp(skill, 0, 1)) * (1.2 + d * 0.09);
  const aim = {
    x: spot.x + (world.rand() * 2 - 1) * spread,
    z: spot.z + (world.rand() * 2 - 1) * spread,
  };
  const dir = normalize(sub(aim, p.pos));
  const power = clamp(5 + d * 0.82, MIN_PASS_POWER, MAX_PASS_POWER) * powerScale;
  applyKick(world, p, dir, power, d > 24 ? 2.4 : 0);
  world.events.push({ type: 'pass', side: p.side, intensity: clamp(power / MAX_PASS_POWER, 0, 1) });
}
