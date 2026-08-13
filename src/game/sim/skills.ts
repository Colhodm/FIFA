import { KICK_COOLDOWN } from '../constants';
import { ballPos2 } from './kick';
import { clamp, dist, dot, normalize, type Vec2 } from './math';
import { onPitch, type SimPlayer, type SimWorld } from './state';

export type SkillMove = 'ball-roll' | 'stepover' | 'drag-back' | 'fake-shot' | 'knock-on';

/** Picks the move from the direction of the flick relative to where the player is facing. */
export function skillFromDirection(player: SimPlayer, dir: Vec2): SkillMove {
  const facing = { x: Math.sin(player.heading), z: Math.cos(player.heading) };
  const forward = dot(normalize(dir), facing);
  if (forward > 0.6) return 'knock-on';
  if (forward < -0.5) return 'drag-back';
  return Math.abs(forward) < 0.25 ? 'ball-roll' : 'stepover';
}

const COST: Record<SkillMove, number> = {
  'ball-roll': 0.012,
  stepover: 0.018,
  'drag-back': 0.015,
  'fake-shot': 0.02,
  'knock-on': 0.03,
};

/**
 * Executes a skill move: the ball is moved off the dribbler's standing foot, the player is
 * committed for a fraction of a second, and any defender the move beats is left off balance.
 * Dribbling decides how far the ball goes and whether the defender actually buys it.
 */
export function performSkill(
  world: SimWorld,
  player: SimPlayer,
  move: SkillMove,
  dir: Vec2,
): boolean {
  if (player.skillTimer > 0 || world.controllerId !== player.id) return false;
  const facing = { x: Math.sin(player.heading), z: Math.cos(player.heading) };
  const side = { x: facing.z, z: -facing.x };
  const flick = normalize(dir);
  const control = 0.55 + player.dribbling / 200;

  let push: Vec2;
  let commit: number;
  switch (move) {
    case 'ball-roll':
      push = { x: side.x * dot(flick, side) * 1.9, z: side.z * dot(flick, side) * 1.9 };
      commit = 0.28;
      break;
    case 'stepover':
      push = { x: flick.x * 2.2 + facing.x * 0.8, z: flick.z * 2.2 + facing.z * 0.8 };
      commit = 0.35;
      break;
    case 'drag-back':
      push = { x: -facing.x * 1.8, z: -facing.z * 1.8 };
      commit = 0.4;
      break;
    case 'fake-shot':
      push = { x: flick.x * 1.6, z: flick.z * 1.6 };
      commit = 0.45;
      break;
    default:
      // Knock-on: shove it into space and go.
      push = { x: facing.x * 4.5, z: facing.z * 4.5 };
      commit = 0.2;
      break;
  }

  const vel = {
    x: push.x * control * 3.2 + player.vel.x * 0.4,
    y: 0,
    z: push.z * control * 3.2 + player.vel.z * 0.4,
  };
  world.ball.vel = vel;
  world.commands.push({ type: 'velocity', vel });
  player.skillTimer = commit;
  player.anim = 'skill';
  player.animTimer = commit;
  player.stamina = clamp(player.stamina - COST[move], 0, 1);
  // The dribbler carries his own momentum into the space he has just made.
  player.vel = { x: player.vel.x + push.x * 0.35, z: player.vel.z + push.z * 0.35 };

  const ball = ballPos2(world);
  for (const defender of onPitch(world)) {
    if (defender.side === player.side) continue;
    const d = dist(defender.pos, ball);
    if (d > 3.5) continue;
    // A convincing move against a committed defender wins a yard.
    const odds = clamp(0.35 + (player.dribbling - defender.defending) / 120, 0.05, 0.9);
    if (world.rand() < odds) {
      defender.kickCooldown = Math.max(defender.kickCooldown, KICK_COOLDOWN + commit);
      defender.vel = { x: defender.vel.x * 0.4, z: defender.vel.z * 0.4 };
    }
  }

  world.events.push({ type: 'skill', side: player.side, intensity: 0.5, text: move });
  return true;
}

/**
 * First touch: a fast ball arriving at a poor technician bobbles away from him. Returns the
 * extra knock, in metres, to apply when the player takes the ball down.
 */
export function firstTouchError(world: SimWorld, player: SimPlayer, ballSpeed: number): Vec2 {
  const quality = clamp(player.dribbling / 100, 0.3, 1);
  const magnitude = clamp((ballSpeed - 6) / 22, 0, 1) * (1.15 - quality) * 1.6;
  if (magnitude < 0.02) return { x: 0, z: 0 };
  const angle = world.rand() * Math.PI * 2;
  return { x: Math.cos(angle) * magnitude, z: Math.sin(angle) * magnitude };
}
