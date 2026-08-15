import { KICK_COOLDOWN } from '../constants';
import { ballPos2 } from './kick';
import { clamp, dist, dot, normalize, type Vec2 } from './math';
import { onPitch, type SimPlayer, type SimWorld } from './state';

export type SkillMove =
  'ball-roll' | 'stepover' | 'drag-back' | 'fake-shot' | 'knock-on' | 'feint-left' | 'feint-right';

/** Picks the move from the direction of the flick relative to where the player is facing. */
export function skillFromDirection(player: SimPlayer, dir: Vec2): SkillMove {
  const facing = { x: Math.sin(player.heading), z: Math.cos(player.heading) };
  const forward = dot(normalize(dir), facing);
  if (forward > 0.6) return 'knock-on';
  if (forward < -0.5) return 'drag-back';
  // Sideways is a body feint — drop the shoulder one way. Which way depends on the side of the
  // flick relative to his facing, so left and right are genuinely different moves.
  if (Math.abs(forward) < 0.35) {
    const side = { x: facing.z, z: -facing.x };
    return dot(normalize(dir), side) > 0 ? 'feint-right' : 'feint-left';
  }
  return 'stepover';
}

const COST: Record<SkillMove, number> = {
  'ball-roll': 0.012,
  stepover: 0.018,
  'drag-back': 0.015,
  'fake-shot': 0.02,
  'knock-on': 0.03,
  // A feint is a body movement, not a touch: cheap, and the ball barely moves.
  'feint-left': 0.008,
  'feint-right': 0.008,
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
    case 'feint-left':
    case 'feint-right': {
      /*
       * A body feint sells a direction with the shoulders and hips while the ball stays under
       * you. That is the whole point of it — every other move here shoves the ball a metre or
       * two, so there was no way to move a defender without also committing the ball.
       */
      const sign = move === 'feint-right' ? 1 : -1;
      push = { x: side.x * sign * 0.35, z: side.z * sign * 0.35 };
      commit = 0.26;
      // Drop the shoulder: the visible heading swings, which is what the defender reads.
      player.heading += sign * 0.5;
      break;
    }
    default:
      // Knock-on: shove it into space and go.
      push = { x: facing.x * 4.5, z: facing.z * 4.5 };
      commit = 0.2;
      break;
  }
  const feinting = move === 'feint-left' || move === 'feint-right';

  const vel = {
    x: push.x * control * 3.2 + player.vel.x * 0.4,
    y: 0,
    z: push.z * control * 3.2 + player.vel.z * 0.4,
  };
  world.ball.vel = vel;
  world.commands.push({ type: 'velocity', vel });
  player.skillTimer = commit;
  player.anim = feinting ? 'feint' : 'skill';
  player.animTimer = commit;
  player.stamina = clamp(player.stamina - COST[move], 0, 1);
  // The dribbler carries his own momentum into the space he has just made.
  const carry = feinting ? 0.1 : 0.35;
  player.vel = { x: player.vel.x + push.x * carry, z: player.vel.z + push.z * carry };

  const ball = ballPos2(world);
  for (const defender of onPitch(world)) {
    if (defender.side === player.side) continue;
    const d = dist(defender.pos, ball);
    if (d > 3.5) continue;
    // A convincing move against a committed defender wins a yard.
    // A feint works on the defender's *read*, so it buys a beat far more often than a touch does
    // — but it wins less space when it lands, because the ball has not gone anywhere.
    const odds = clamp(
      (feinting ? 0.55 : 0.35) + (player.dribbling - defender.defending) / 120,
      0.05,
      feinting ? 0.95 : 0.9,
    );
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
