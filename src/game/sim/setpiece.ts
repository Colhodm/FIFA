import { HALF_GOAL_WIDTH, MAX_SHOT_POWER, MIN_SHOT_POWER } from '../constants';
import { kickPass, registerShot } from './ai';
import { applyKick, bestCross, bestPass, curlToward, goalCenter } from './kick';
import { clamp, dist, normalize, sub, type Vec2 } from './math';
import {
  DIFFICULTY,
  TEAMMATE_PROFILE,
  onPitch,
  type SetPiece,
  type SimPlayer,
  type SimWorld,
} from './state';

/** Where the taker stands while he waits: a stride behind the ball, facing up the pitch. */
export function takerApproach(world: SimWorld, set: SetPiece): Vec2 {
  const goal = goalCenter(world, set.side);
  const back = normalize(sub(set.spot, goal));
  const step = set.kind === 'penalty' ? 2.4 : 1.3;
  return { x: set.spot.x + back.x * step, z: set.spot.z + back.z * step };
}

/** True once the taker is allowed to play the ball. */
export const canTake = (set: SetPiece): boolean => set.prepare <= 0;

export function findTaker(world: SimWorld, set: SetPiece): SimPlayer | null {
  const taker = world.players.find((p) => p.id === set.takerId && !p.sentOff);
  if (taker) return taker;
  const replacement = onPitch(world).find(
    (p) => p.side === set.side && (set.kind === 'goal-kick' ? p.role === 'GK' : p.role !== 'GK'),
  );
  if (replacement) set.takerId = replacement.id;
  return replacement ?? null;
}

/**
 * The CPU taking a set piece. Corners and free kicks in range are whipped in or bent at goal;
 * everything else is played short to the best available option.
 */
export function aiTakeSetPiece(world: SimWorld, set: SetPiece, taker: SimPlayer): void {
  const profile =
    taker.side === world.config.humanSide ? TEAMMATE_PROFILE : DIFFICULTY[world.config.difficulty];
  const goal = goalCenter(world, set.side);

  if (set.kind === 'penalty') {
    takePenalty(world, taker, null, 0.85);
    return;
  }

  if (set.kind === 'corner') {
    const option = bestCross(world, taker);
    const spot = option ? option.spot : { x: goal.x - world.attackDir[set.side] * 6, z: 0 };
    kickPass(world, taker, spot, profile, 1.1, {
      lift: 4.6,
      curl: curlToward(taker.pos, sub(spot, taker.pos), goal, 0.6),
    });
    return;
  }

  if (set.kind === 'free-kick') {
    const d = dist(taker.pos, goal);
    const central = Math.abs(taker.pos.z) < 22;
    if (d < 30 && central && taker.shooting > 60) {
      // Bend it over the wall into the far corner.
      const side = Math.sign(taker.pos.z || (world.rand() < 0.5 ? 1 : -1));
      const aim = { x: goal.x, z: -side * (HALF_GOAL_WIDTH - 0.7) };
      const dir = normalize(sub(aim, taker.pos));
      const power = clamp(MIN_SHOT_POWER + d * 0.5, MIN_SHOT_POWER, MAX_SHOT_POWER * 0.9);
      applyKick(world, taker, dir, power, 2.6, curlToward(taker.pos, dir, aim, 1));
      registerShot(world, taker, aim);
      world.events.push({ type: 'shot', side: taker.side, intensity: 0.9 });
      return;
    }
    if (d < 48) {
      const option = bestCross(world, taker);
      const spot = option ? option.spot : { x: goal.x - world.attackDir[set.side] * 10, z: 0 };
      kickPass(world, taker, spot, profile, 1.05, { lift: 4.2 });
      return;
    }
  }

  const pass = bestPass(world, taker);
  const upfield = normalize(sub(goal, taker.pos));
  if (pass) {
    kickPass(world, taker, pass.spot, profile, set.kind === 'goal-kick' ? 1.1 : 0.85, {
      lift: set.kind === 'goal-kick' ? 4 : set.kind === 'throw-in' ? 1.6 : 0,
    });
    return;
  }
  applyKick(world, taker, upfield, set.kind === 'goal-kick' ? 24 : 12, 4);
  world.events.push({ type: 'kick', side: taker.side, intensity: 0.8 });
}

/**
 * Penalty: the taker picks a corner, the keeper guesses. `aim` is the human's chosen
 * direction; the CPU picks its own side.
 */
export function takePenalty(
  world: SimWorld,
  taker: SimPlayer,
  aimDir: Vec2 | null,
  power: number,
): void {
  const goal = goalCenter(world, taker.side);
  const side = aimDir
    ? Math.sign(aimDir.z || (world.rand() < 0.5 ? 1 : -1))
    : world.rand() < 0.5
      ? -1
      : 1;
  const placement = (HALF_GOAL_WIDTH - 0.45) * (0.55 + (taker.shooting / 100) * 0.4);
  const spread = (1 - taker.shooting / 130) * 1.4;
  const aim = {
    x: goal.x,
    z: side * placement + (world.rand() * 2 - 1) * spread,
  };
  const dir = normalize(sub(aim, taker.pos));
  const speed = (18 + (taker.shooting / 100) * 8) * clamp(power, 0.5, 1.15);
  applyKick(world, taker, dir, speed, aimDir && aimDir.x > 0.6 ? 1.6 : 0.5);
  // From twelve yards the keeper cannot react to the ball — he picks a corner and goes. This
  // commits him before the flight-reading dive in updateKeepers can play the shot perfectly.
  const keeper = onPitch(world).find((p) => p.role === 'GK' && p.side !== taker.side);
  if (keeper && keeper.anim !== 'dive' && keeper.diveDir === 0) {
    const guess = world.rand() < 0.5 ? -1 : 1;
    keeper.diveDir = guess;
    keeper.diveTargetZ = keeper.pos.z + guess * (1.4 + world.rand() * 1.8);
    keeper.anim = 'dive';
    keeper.animTimer = 0.9;
    keeper.verticalVel = Math.sqrt(2 * 9.81 * 1.1) * 0.5;
  }
  registerShot(world, taker, aim);
  world.events.push({ type: 'shot', side: taker.side, intensity: 1 });
}
