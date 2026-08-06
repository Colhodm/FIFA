import {
  ACCELERATION,
  BASE_SPEED,
  CHARGE_TIME,
  CONTROL_RADIUS,
  HALF_LENGTH,
  HALF_WIDTH,
  KICK_COOLDOWN,
  MAX_PASS_POWER,
  MAX_SHOT_POWER,
  MIN_PASS_POWER,
  MIN_SHOT_POWER,
  PLAYER_RADIUS,
  SPRINT_MULTIPLIER,
  STAMINA_DRAIN_RUN,
  STAMINA_DRAIN_SPRINT,
  STAMINA_RECOVERY,
  TURN_RATE,
} from '../constants';
import type { InputFrame } from '../input/input';
import type { TeamSide } from '../types';
import { decideOffBall, decideOnBall, kickPass, nearestOf, shoot } from './ai';
import { applyKick, ballPos2, bestPass, goalCenter } from './kick';
import { angleDelta, clamp, dist, normalize, sub, type Vec2 } from './math';
import { advanceClock, checkBallOut, startSecondHalf } from './rules';
import {
  DIFFICULTY,
  TEAMMATE_PROFILE,
  resetToKickoff,
  type DifficultyProfile,
  type SimPlayer,
  type SimWorld,
} from './state';

const HUMAN_PROFILE: DifficultyProfile = {
  reaction: 0,
  sprintBias: 1,
  marking: 1,
  shotAccuracy: 0.92,
  passAccuracy: 0.94,
};

const other = (side: TeamSide): TeamSide => (side === 'home' ? 'away' : 'home');

const profileFor = (world: SimWorld, p: SimPlayer): DifficultyProfile =>
  p.side === world.config.humanSide ? TEAMMATE_PROFILE : DIFFICULTY[world.config.difficulty];

/** Rotates camera-relative input into pitch space. */
function inputToWorld(move: Vec2, cameraYaw: number): Vec2 {
  const sin = Math.sin(cameraYaw);
  const cos = Math.cos(cameraYaw);
  return {
    x: move.z * sin + move.x * cos,
    z: move.z * cos - move.x * sin,
  };
}

const isLive = (world: SimWorld): boolean => world.phase === 'in-play';
const playersMove = (world: SimWorld): boolean =>
  world.phase !== 'end' && world.phase !== 'halftime';

export function tick(world: SimWorld, input: InputFrame, cameraYaw: number, dt: number): void {
  switch (world.phase) {
    case 'kickoff':
      world.phaseTimer -= dt;
      if (world.phaseTimer <= 0) {
        world.phase = 'in-play';
        world.banner = '';
        world.events.push({ type: 'kickoff' });
        world.events.push({ type: 'whistle', intensity: 0.5 });
      }
      break;
    case 'restart':
      world.phaseTimer -= dt;
      freezeBall(world);
      if (world.phaseTimer <= 0) {
        world.phase = 'in-play';
        world.banner = '';
        world.restart = null;
      }
      break;
    case 'goal':
      world.phaseTimer -= dt;
      freezeBall(world);
      if (world.phaseTimer <= 0) {
        const conceded = other(world.lastScorer ?? 'away');
        if (world.clock >= world.config.halfLength) advanceClock(world, 0);
        else resetToKickoff(world, conceded);
      }
      break;
    case 'halftime':
      world.phaseTimer -= dt;
      if (world.phaseTimer <= 0) startSecondHalf(world);
      break;
    case 'end':
      return;
    default:
      break;
  }

  if (isLive(world)) advanceClock(world, dt);
  if (world.phase === 'kickoff') freezeBall(world);

  if (playersMove(world)) {
    updatePlayers(world, input, cameraYaw, dt);
    resolveOverlaps(world);
  }

  if (isLive(world)) {
    resolveChallenges(world, dt);
    updateControl(world);
    handleHumanActions(world, input, cameraYaw);
    if (world.possession) world.possessionTicks[world.possession] += 1;
    checkBallOut(world);
  }
}

function freezeBall(world: SimWorld): void {
  const { vel } = world.ball;
  if (Math.abs(vel.x) + Math.abs(vel.y) + Math.abs(vel.z) < 0.01) return;
  world.commands.push({ type: 'velocity', vel: { x: 0, y: 0, z: 0 } });
  world.ball.vel = { x: 0, y: 0, z: 0 };
}

function updatePlayers(world: SimWorld, input: InputFrame, cameraYaw: number, dt: number): void {
  const humanControlled = world.activeId;
  for (const p of world.players) {
    p.kickCooldown = Math.max(0, p.kickCooldown - dt);

    let desired: Vec2;
    let sprint: boolean;
    if (p.id === humanControlled) {
      desired = inputToWorld(input.move, cameraYaw);
      sprint = input.actions.sprint.down && p.stamina > 0.05;
    } else {
      const profile = profileFor(world, p);
      p.thinkTimer -= dt;
      if (p.thinkTimer <= 0) {
        // Keepers and the ball carrier re-decide faster than the rest of the team.
        const cadence = p.role === 'GK' || world.controllerId === p.id ? 0.4 : 1;
        p.thinkTimer = profile.reaction * cadence * (0.75 + world.rand() * 0.5) + 0.02;
        if (world.controllerId === p.id && isLive(world)) decideOnBall(world, p, profile);
        else decideOffBall(world, p, profile);
      } else if (world.controllerId === p.id && isLive(world)) {
        // Keep steering towards goal between decisions so dribbling stays smooth.
        const goal = goalCenter(world, p.side);
        p.intent = normalize(sub(goal, p.pos));
      }
      desired = p.intent;
      sprint = p.intentSprint && p.stamina > 0.08;
    }

    integrate(p, desired, sprint, dt);
  }
}

function integrate(p: SimPlayer, desired: Vec2, sprint: boolean, dt: number): void {
  const throttle = Math.min(1, Math.hypot(desired.x, desired.z));
  const dir = normalize(desired);
  const staminaFactor = 0.72 + 0.28 * clamp(p.stamina * 1.4, 0, 1);
  // Keepers shuffle and dive rather than sprint across their line.
  const maxSpeed =
    BASE_SPEED *
    (0.86 + (p.pace / 100) * 0.3) *
    (sprint ? SPRINT_MULTIPLIER : 1) *
    staminaFactor *
    (p.role === 'GK' ? 0.78 : 1);
  const target = { x: dir.x * maxSpeed * throttle, z: dir.z * maxSpeed * throttle };

  // Sprinting trades agility for speed.
  const accel = ACCELERATION * (sprint ? 0.72 : 1);
  const dvx = target.x - p.vel.x;
  const dvz = target.z - p.vel.z;
  const dv = Math.hypot(dvx, dvz);
  const step = Math.min(dv, accel * dt);
  if (dv > 1e-5) {
    p.vel.x += (dvx / dv) * step;
    p.vel.z += (dvz / dv) * step;
  }

  p.pos.x = clamp(p.pos.x + p.vel.x * dt, -HALF_LENGTH - 2.5, HALF_LENGTH + 2.5);
  p.pos.z = clamp(p.pos.z + p.vel.z * dt, -HALF_WIDTH - 2.5, HALF_WIDTH + 2.5);

  const speed = Math.hypot(p.vel.x, p.vel.z);
  if (speed > 0.35) {
    const want = Math.atan2(p.vel.x, p.vel.z);
    const rate = TURN_RATE * (sprint ? 0.6 : 1);
    p.heading += clamp(angleDelta(p.heading, want), -rate * dt, rate * dt);
  }

  const endurance = 0.6 + (p.enduranceRating / 100) * 0.6;
  if (sprint && speed > 1) p.stamina -= (STAMINA_DRAIN_SPRINT / endurance) * dt;
  else if (speed > 1) p.stamina -= (STAMINA_DRAIN_RUN / endurance) * dt;
  else p.stamina += STAMINA_RECOVERY * endurance * dt;
  p.stamina = clamp(p.stamina, 0, 1);
}

/** Players are kinematic bodies, so they need a cheap separation pass of their own. */
function resolveOverlaps(world: SimWorld): void {
  const min = PLAYER_RADIUS * 2;
  const players = world.players;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > min * min || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      const push = (min - d) / 2;
      const nx = dx / d;
      const nz = dz / d;
      a.pos.x -= nx * push;
      a.pos.z -= nz * push;
      b.pos.x += nx * push;
      b.pos.z += nz * push;
    }
  }
}

const CHALLENGE_RADIUS = 1.4;

/**
 * Defenders cannot simply out-reach a dribbler (the ball is glued to his feet), so closing
 * a carrier down wins the ball probabilistically — defending rating versus the carrier's pace.
 */
function resolveChallenges(world: SimWorld, dt: number): void {
  const carrier = world.players.find((p) => p.id === world.controllerId);
  if (!carrier) return;
  for (const opponent of world.players) {
    if (opponent.side === carrier.side || opponent.kickCooldown > 0) continue;
    const radius = opponent.role === 'GK' ? 2.4 : CHALLENGE_RADIUS;
    const d = dist(opponent.pos, carrier.pos);
    if (d > radius) continue;
    const closeness = 1 - d / radius;
    const skill = opponent.role === 'GK' ? 2.5 : 0.5 + (opponent.defending - carrier.pace) / 160;
    if (world.rand() > clamp(skill, 0.12, 2.5) * closeness * dt) continue;

    carrier.kickCooldown = KICK_COOLDOWN * 1.6;
    world.controllerId = opponent.id;
    world.possession = opponent.side;
    world.lastTouch = { side: opponent.side, playerId: opponent.id };
    world.events.push({ type: 'tackle', side: opponent.side, intensity: closeness });
    // Poke the ball towards the winner so he can actually pick it up.
    const toWinner = normalize(sub(opponent.pos, ballPos2(world)));
    const vel = { x: toWinner.x * 3.2, y: 0, z: toWinner.z * 3.2 };
    world.ball.vel = vel;
    world.commands.push({ type: 'velocity', vel });
    autoSwitch(world, opponent);
    return;
  }
}

/** Decides who has the ball this tick and glues it to the dribbler's feet. */
function updateControl(world: SimWorld): void {
  const ball = ballPos2(world);
  const previous = world.controllerId;
  const ballSpeed = Math.hypot(world.ball.vel.x, world.ball.vel.z);

  let holder: SimPlayer | null = null;
  let bestD = Infinity;
  let blocker: SimPlayer | null = null;
  for (const p of world.players) {
    if (p.kickCooldown > 0) continue;
    const keeper = p.role === 'GK';
    const reach = CONTROL_RADIUS + (keeper ? 0.55 : 0);
    const height = keeper ? 2.6 : 1.5;
    if (world.ball.pos.y > height) continue;
    const d = dist(p.pos, ball);
    if (d >= reach) continue;
    // A struck ball cannot simply be plucked out of the air: keepers claim all but the
    // hardest strikes, outfield players only deflect one at point-blank range.
    const limit = keeper ? 18 : 10 + (p.defending + p.passing) / 40;
    if (ballSpeed > limit) {
      const incoming =
        world.ball.vel.x * (p.pos.x - ball.x) + world.ball.vel.z * (p.pos.z - ball.z) > 0;
      const blockRadius = keeper ? reach : 0.45;
      if (incoming && d < blockRadius && (!blocker || d < dist(blocker.pos, ball))) blocker = p;
      continue;
    }
    // Even a controllable ball takes a touch to settle: the quicker it moves, the more
    // often it squirms away instead of sticking to the first man there.
    if (
      p.id !== previous &&
      ballSpeed > 3 &&
      world.rand() > clamp(1.15 - ballSpeed / limit, 0.12, 1)
    ) {
      continue;
    }
    if (d < bestD) {
      bestD = d;
      holder = p;
    }
  }

  if (!holder && blocker) {
    const away = normalize(sub(blocker.pos, ball));
    const vel = {
      x: (world.ball.vel.x * -0.25 + away.x * 3) * 0.9,
      y: world.ball.vel.y * 0.4,
      z: (world.ball.vel.z * -0.25 + away.z * 3) * 0.9,
    };
    world.ball.vel = vel;
    world.commands.push({ type: 'velocity', vel });
    world.lastTouch = { side: blocker.side, playerId: blocker.id };
    blocker.kickCooldown = KICK_COOLDOWN * 0.8;
    world.events.push({ type: 'tackle', side: blocker.side, intensity: 0.5 });
    world.controllerId = null;
    return;
  }

  world.controllerId = holder ? holder.id : null;
  if (!holder) return;

  if (previous !== holder.id) {
    if (holder.role === 'GK' && ballSpeed > 12) {
      world.events.push({
        type: 'save',
        side: holder.side,
        intensity: clamp(ballSpeed / 25, 0, 1),
      });
    }
    if (world.possession !== holder.side) autoSwitch(world, holder);
  }
  world.possession = holder.side;
  world.lastTouch = { side: holder.side, playerId: holder.id };

  // Nudge the ball to a dribbling position just ahead of the player.
  const ahead = {
    x: holder.pos.x + Math.sin(holder.heading) * 0.62,
    z: holder.pos.z + Math.cos(holder.heading) * 0.62,
  };
  const toAhead = sub(ahead, ball);
  const cap = Math.hypot(holder.vel.x, holder.vel.z) + 5;
  const vx = clamp(toAhead.x / 0.16, -cap, cap);
  const vz = clamp(toAhead.z / 0.16, -cap, cap);
  world.ball.vel = { x: vx, y: world.ball.vel.y, z: vz };
  world.commands.push({ type: 'velocity', vel: { x: vx, y: world.ball.vel.y, z: vz } });
}

/** Hands the human the most useful player when possession flips. */
function autoSwitch(world: SimWorld, holder: SimPlayer): void {
  const human = world.config.humanSide;
  if (holder.side === human) {
    if (holder.role !== 'GK') world.activeId = holder.id;
    return;
  }
  const chaser = nearestOf(world, holder.pos, human);
  if (chaser) world.activeId = chaser.id;
}

const chargeOf = (heldTime: number): number => clamp(heldTime / CHARGE_TIME, 0.15, 1);

function handleHumanActions(world: SimWorld, input: InputFrame, cameraYaw: number): void {
  const active = world.players.find((p) => p.id === world.activeId);
  if (!active) return;
  const moveDir = inputToWorld(input.move, cameraYaw);
  const facing = { x: Math.sin(active.heading), z: Math.cos(active.heading) };
  const aimDir = Math.hypot(moveDir.x, moveDir.z) > 0.2 ? moveDir : facing;
  const hasBall = world.controllerId === active.id;

  if (input.actions.switch.pressed && !hasBall) switchPlayer(world);

  if (hasBall && input.actions.shoot.released) {
    const charge = chargeOf(input.actions.shoot.heldTime);
    const goal = goalCenter(world, active.side);
    const d = dist(active.pos, goal);
    if (d < 40) {
      shoot(world, active, HUMAN_PROFILE, 1, 0.55 + charge * 0.65);
    } else {
      applyKick(
        world,
        active,
        aimDir,
        MIN_SHOT_POWER + charge * (MAX_SHOT_POWER - MIN_SHOT_POWER),
        1.8,
      );
      world.events.push({ type: 'kick', side: active.side, intensity: charge });
    }
    return;
  }

  if (hasBall && input.actions.pass.released) {
    const charge = chargeOf(input.actions.pass.heldTime);
    const option = bestPass(world, active, aimDir);
    if (option) {
      kickPass(world, active, option.spot, HUMAN_PROFILE, 0.7 + charge * 0.6);
    } else {
      applyKick(
        world,
        active,
        aimDir,
        MIN_PASS_POWER + charge * (MAX_PASS_POWER - MIN_PASS_POWER),
        0,
      );
      world.events.push({ type: 'kick', side: active.side, intensity: charge });
    }
    return;
  }

  if (input.actions.tackle.pressed && !hasBall) tackle(world, active);
}

function switchPlayer(world: SimWorld): void {
  const human = world.config.humanSide;
  const ball = ballPos2(world);
  const candidates = world.players
    .filter((p) => p.side === human && p.role !== 'GK' && p.id !== world.activeId)
    .sort((a, b) => dist(a.pos, ball) - dist(b.pos, ball));
  if (candidates.length) world.activeId = candidates[0].id;
}

function tackle(world: SimWorld, tackler: SimPlayer): void {
  const target = world.players.find((p) => p.id === world.controllerId);
  tackler.kickCooldown = Math.max(tackler.kickCooldown, 0.25);
  if (!target || target.side === tackler.side) return;
  const d = dist(tackler.pos, target.pos);
  if (d > 2.4) return;
  const odds = clamp(0.35 + (tackler.defending - target.pace) / 120 + (2.4 - d) * 0.18, 0.1, 0.92);
  world.events.push({ type: 'tackle', side: tackler.side, intensity: clamp(odds, 0, 1) });
  if (world.rand() > odds) return;
  const dir = normalize(sub(goalCenter(world, tackler.side), tackler.pos));
  applyKick(world, tackler, dir, 8, 0.4);
  target.kickCooldown = KICK_COOLDOWN * 2;
  world.controllerId = null;
  world.possession = tackler.side;
  autoSwitch(world, tackler);
}
