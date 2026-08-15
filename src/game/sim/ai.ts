import {
  HALF_GOAL_WIDTH,
  HALF_LENGTH,
  HALF_WIDTH,
  MAX_PASS_POWER,
  MAX_SHOT_POWER,
  MIN_PASS_POWER,
  MIN_SHOT_POWER,
} from '../constants';
import {
  applyKick,
  ballPos2,
  bestPass,
  bestThroughBall,
  curlToward,
  goalCenter,
  ownGoalCenter,
  shotQuality,
} from './kick';
import { strike, type ShotStyle } from './finishing';
import { distToSegment, clamp, dist, normalize, sub, type Vec2 } from './math';
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
    if (p.side !== side || p.id === exclude || p.sentOff) continue;
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
    if (o.side === p.side || o.sentOff) continue;
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
    if (o.side === p.side || o.role === 'GK' || o.sentOff) continue;
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
  /*
   * Recovery runs. Sprinting off the ball used to be a coin flip against `sprintBias`, so a
   * midfielder caught upfield when possession turned over would amble back at a jog while the
   * break went past him. If he is the wrong side of the ball with his own goal behind him, he
   * runs — that is not a decision a footballer agonises over.
   */
  const recovering = !teamHasBall && (p.pos.x - world.ball.pos.x) * world.attackDir[p.side] > 2;
  const wantsSprint =
    (recovering && p.stamina > 0.12) || (p.stamina > 0.25 && world.rand() < profile.sprintBias);

  if (!teamHasBall) {
    /*
     * A ball has been struck at our goal. Anyone close to its line throws himself in front of
     * it rather than carrying on marking a runner — previously a shot simply flew past
     * defenders who were still holding their shape, which is the thing that reads as nobody
     * caring that a shot is happening.
     */
    const struck = Math.hypot(world.ball.vel.x, world.ball.vel.z);
    /*
     * A defender does not know where a shot is going the instant it leaves the boot. Reading the
     * ball's velocity on the tick it was struck gave every defender perfect knowledge with zero
     * latency, which is what produces blocks that look impossible. He reacts only after his own
     * perception delay — quicker if he is a good defender, slower if the ball is behind him.
     */
    const facing = { x: Math.sin(p.heading), z: Math.cos(p.heading) };
    const toBall = normalize(sub(ball, p.pos));
    const seesIt = facing.x * toBall.x + facing.z * toBall.z > 0.1;
    const reaction =
      (seesIt ? 0.2 : 0.42) + (1 - profile.marking) * 0.12 + (1 - p.defending / 100) * 0.16;
    if (
      world.shotAge >= reaction &&
      struck > 13 &&
      world.ball.pos.y < 1.8 &&
      dist(ball, ownGoalCenter(world, p.side)) < 30
    ) {
      const own = ownGoalCenter(world, p.side);
      const goingAtGoal = (own.x - world.ball.pos.x) * world.ball.vel.x > 0;
      if (goingAtGoal) {
        // Where the ball will be in a moment, and how far he is off that line.
        const lead = 0.35;
        const ahead = {
          x: world.ball.pos.x + world.ball.vel.x * lead,
          z: world.ball.pos.z + world.ball.vel.z * lead,
        };
        const offLine = distToSegment(p.pos, ball, ahead);
        if (offLine < 2.2) {
          setIntent(p, clampToPitch(ahead), true);
          return;
        }
      }
    }
    /*
     * A ball is travelling between two opponents. Only the single nearest defender ever went for
     * it, so a pass into a lane a defender was standing in simply sailed past him. Anyone close
     * to the line attacks it — once his own perception delay has elapsed, so this reads as
     * reading the pass rather than clairvoyance.
     */
    // Passes only. A ball hammered at our goal is the shot-block branch's business above, which
    // is gated far more tightly; letting this one chase shots as well doubled the block rate.
    const isPass = struck > 5 && struck < 24;
    if (world.controllerId === null && isPass) {
      const lead = 0.5;
      const ahead = {
        x: world.ball.pos.x + world.ball.vel.x * lead,
        z: world.ball.pos.z + world.ball.vel.z * lead,
      };
      const offLine = distToSegment(p.pos, ball, ahead);
      if (world.shotAge >= reaction && offLine < 3.5 && chaser?.id !== p.id) {
        setIntent(p, clampToPitch(interceptPoint(world, 0.35)), p.stamina > 0.12);
        return;
      }
    }
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
  // The ball has been played to this man: go and get it, do not stand in your shape and watch
  // the defender run onto it.
  if (!carrier && world.passTarget?.playerId === p.id) {
    setIntent(p, clampToPitch(interceptPoint(world, 0.4)), p.stamina > 0.12);
    return;
  }
  // A pass is in flight: the closest man goes and meets it instead of holding his shape.
  if (!carrier && chaser?.id === p.id) {
    setIntent(p, clampToPitch(interceptPoint(world, 0.5)), p.stamina > 0.15);
    return;
  }
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
      kickPass(world, p, pass.spot, profile, 1, { receiverId: pass.target.id });
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
  // Nobody dribbles it over the line: from the six-yard box he simply hits it.
  const pointBlank = goalDist < 16 && Math.abs(p.pos.z) < 14 && (pressure > 1.6 || goalDist < 7);
  if (pointBlank || quality > shootBar) {
    shoot(world, p, profile, quality);
    return true;
  }

  // Look for the pass that breaks the line first, then the safe one.
  const through = bestThroughBall(world, p);
  if (through && through.score > 1.9 && p.passing > 62) {
    kickPass(world, p, through.spot, profile, 0.95, { receiverId: through.target.id });
    return true;
  }

  const pass = bestPass(world, p);
  if (pass && (pressure < 3.4 || pass.score > 1.5) && pass.score > 0.55) {
    kickPass(world, p, pass.spot, profile, 1, { receiverId: pass.target.id });
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
  // Under real pressure a strong carrier shields the ball instead of running into the tackle.
  p.shielding = pressure < 1.8 && p.physical > 68;
  p.intentSprint = !p.shielding && p.stamina > 0.2 && world.rand() < profile.sprintBias;
  return false;
}

/**
 * `speed` overrides the strike entirely: the human's hold-to-power model decides the pace, and
 * this function only does the aiming. Without it the shot speed came out of the distance to
 * goal and the charge merely scaled it, so hold time barely related to how hard the ball was
 * hit and a full charge never got near the configured maximum.
 */
export function shoot(
  world: SimWorld,
  p: SimPlayer,
  profile: DifficultyProfile,
  quality: number,
  powerScale = 1,
  speed?: number,
): void {
  const goal = goalCenter(world, p.side);
  const d = dist(p.pos, goal);
  // The CPU finishes through the same solver as the player: pick a target, then solve the
  // launch that reaches it. Difficulty rides on the spread, not on a different mechanism.
  const charge = clamp(
    (speed ?? clamp(MIN_SHOT_POWER + d * 0.62, MIN_SHOT_POWER, MAX_SHOT_POWER) * powerScale) /
      world.tuning.shot.maxSpeed,
    0.35,
    1,
  );
  const tuning = {
    ...world.tuning.shot,
    // A weaker profile, or a snatched chance, simply misses by more.
    baseSpread:
      world.tuning.shot.baseSpread * (2.1 - profile.shotAccuracy * 1.6) * (1.3 - quality * 0.3),
  };
  const style: ShotStyle = d > 24 && world.rand() < 0.5 ? 'driven' : 'finesse';
  const result = strike(
    world,
    p,
    { style, charge, aim: null, pressure: nearestOpponentDistance(world, p) },
    tuning,
  );
  registerShot(world, p, { x: goal.x, z: result.targetZ });
  world.events.push({
    type: 'shot',
    side: p.side,
    intensity: clamp(result.speed / world.tuning.shot.maxSpeed, 0, 1),
  });
}

export interface PassOptions {
  /** Vertical impulse. 0 keeps it on the deck; a lofted pass or cross needs 3+. */
  lift?: number;
  /** Side spin in rad/s. Defaults to a little natural whip on anything lofted. */
  curl?: number;
  /**
   * Explicit horizontal ball speed in m/s. The human's hold-to-power model sets this so the
   * charge decides the pace; leave it unset and the AI's distance-based strength is used.
   */
  speed?: number;
  /** The team-mate the pass is meant for, so he goes and meets it. */
  receiverId?: number;
}

export function kickPass(
  world: SimWorld,
  p: SimPlayer,
  spot: Vec2,
  profile: DifficultyProfile,
  powerScale = 1,
  options: PassOptions = {},
): void {
  const d = dist(p.pos, spot);
  const skill = profile.passAccuracy * (0.6 + p.passing / 250);
  const spread = (1 - clamp(skill, 0, 1)) * (1.2 + d * 0.09);
  const aim = {
    x: spot.x + (world.rand() * 2 - 1) * spread,
    z: spot.z + (world.rand() * 2 - 1) * spread,
  };
  const dir = normalize(sub(aim, p.pos));
  const power = options.speed ?? clamp(5 + d * 0.82, MIN_PASS_POWER, MAX_PASS_POWER) * powerScale;
  const lift = options.lift ?? (d > 24 ? 2.4 : 0);
  // A whipped cross bends away from the keeper; a ground pass is struck flat.
  const curl = options.curl ?? (lift > 2.5 ? curlToward(p.pos, dir, aim, 0.35) : 0);
  applyKick(world, p, dir, power, lift, curl, 'pass');
  // Tell the intended receiver the ball is for him; cleared as soon as anyone controls it.
  if (options.receiverId !== undefined) {
    world.passTarget = { playerId: options.receiverId, spot };
    // He reacts to the pass now rather than on his next scheduled think, which can be most of
    // a second away — long enough for a defender to get there first.
    const receiver = world.players.find((r) => r.id === options.receiverId);
    if (receiver) receiver.thinkTimer = 0;
  }
  world.stats[p.side].passes += 1;
  p.tally.passes += 1;
  world.events.push({ type: 'pass', side: p.side, intensity: clamp(power / MAX_PASS_POWER, 0, 1) });
}

/** Records a shot and whether it was heading between the posts. */
export function registerShot(world: SimWorld, p: SimPlayer, aim: Vec2): void {
  world.shots[p.side] += 1;
  world.stats[p.side].shots += 1;
  p.tally.shots += 1;
  if (Math.abs(aim.z) < HALF_GOAL_WIDTH) world.stats[p.side].onTarget += 1;
}
