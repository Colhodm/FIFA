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
import {
  applyKick,
  ballPos2,
  bestCross,
  bestPass,
  bestThroughBall,
  goalCenter,
  ownGoalCenter,
} from './kick';
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
    let face: Vec2 | null = null;
    if (p.id === humanControlled) {
      const hasBall = world.controllerId === p.id;
      const jockey = input.actions.jockey.down;
      // Hold pass off the ball to contain: the player backs off goal-side of the carrier.
      const contain = !hasBall && input.actions.pass.down;
      p.shielding = jockey;
      desired = inputToWorld(input.move, cameraYaw);
      if (contain) desired = containTarget(world, p);
      if (jockey) {
        desired = { x: desired.x * 0.55, z: desired.z * 0.55 };
        face = sub(ballPos2(world), p.pos);
      }
      sprint = input.actions.sprint.down && !jockey && !contain && p.stamina > 0.05;
    } else {
      // Only the carrier shields; decideOnBall re-arms this on its own cadence.
      if (world.controllerId !== p.id) p.shielding = false;
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

    integrate(p, desired, sprint, dt, face);
  }
}

/** Goal-side containing position: stay between the ball and your own net, a stride off it. */
function containTarget(world: SimWorld, p: SimPlayer): Vec2 {
  const ball = ballPos2(world);
  const own = ownGoalCenter(world, p.side);
  const goalSide = normalize(sub(own, ball));
  const spot = { x: ball.x + goalSide.x * 2, z: ball.z + goalSide.z * 2 };
  const to = sub(spot, p.pos);
  const d = Math.hypot(to.x, to.z);
  const n = normalize(to);
  return { x: n.x * clamp(d / 2, 0, 1), z: n.z * clamp(d / 2, 0, 1) };
}

function integrate(
  p: SimPlayer,
  desired: Vec2,
  sprint: boolean,
  dt: number,
  face: Vec2 | null = null,
): void {
  const throttle = Math.min(1, Math.hypot(desired.x, desired.z));
  const dir = normalize(desired);
  const staminaFactor = 0.72 + 0.28 * clamp(p.stamina * 1.4, 0, 1);
  // Keepers shuffle and dive rather than sprint across their line.
  const maxSpeed =
    BASE_SPEED *
    (0.78 + (p.pace / 100) * 0.44) *
    (sprint ? SPRINT_MULTIPLIER : 1) *
    staminaFactor *
    (p.shielding ? 0.72 : 1) *
    (p.role === 'GK' ? 0.78 : 1);
  const target = { x: dir.x * maxSpeed * throttle, z: dir.z * maxSpeed * throttle };

  // Sprinting trades agility for speed; dribbling buys it back.
  const accel = ACCELERATION * (0.82 + p.dribbling / 320) * (sprint ? 0.72 : 1);
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
  // Phase advances with distance covered, so strides never skate over the grass.
  p.gait = (p.gait + (speed * dt) / 0.85) % (Math.PI * 2);
  const facing = face && Math.hypot(face.x, face.z) > 0.01 ? face : speed > 0.35 ? p.vel : null;
  if (facing) {
    const want = Math.atan2(facing.x, facing.z);
    const rate = TURN_RATE * (0.8 + p.dribbling / 400) * (sprint ? 0.6 : 1);
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
      const push = min - d;
      const nx = dx / d;
      const nz = dz / d;
      // The stronger man holds his ground in a shoulder-to-shoulder.
      const share = clamp(0.5 + (b.physical - a.physical) / 200, 0.2, 0.8);
      a.pos.x -= nx * push * share;
      a.pos.z -= nz * push * share;
      b.pos.x += nx * push * (1 - share);
      b.pos.z += nz * push * (1 - share);
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
    // Tackling pits defending and strength against the carrier's close control and strength.
    const attack = (opponent.defending + opponent.physical) / 2;
    const defence = (carrier.dribbling + carrier.physical) / 2;
    const skill =
      opponent.role === 'GK'
        ? 2.5
        : (0.55 + (attack - defence) / 150) * (carrier.shielding ? 0.4 : 1);
    if (world.rand() > clamp(skill, 0.08, 2.5) * closeness * dt) continue;

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
    const limit = keeper ? 18 : 10 + (p.defending + p.dribbling) / 40;
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

  // Nudge the ball to a dribbling position just ahead of the player: good close control keeps
  // it tight, while pace on the ball knocks it further in front.
  const knock =
    0.5 + (1 - holder.dribbling / 100) * 0.45 + Math.hypot(holder.vel.x, holder.vel.z) * 0.03;
  const ahead = {
    x: holder.pos.x + Math.sin(holder.heading) * knock,
    z: holder.pos.z + Math.cos(holder.heading) * knock,
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

/**
 * Face buttons do different jobs with and without the ball, exactly like the pad: shoot/tackle,
 * cross/slide, pass/contain, through ball/nothing. R1 (driven, finesse, threaded) and L1
 * (chipped, lofted, high) modify whichever kick is played.
 */
function handleHumanActions(world: SimWorld, input: InputFrame, cameraYaw: number): void {
  const active = world.players.find((p) => p.id === world.activeId);
  if (!active) return;
  const a = input.actions;
  const moveDir = inputToWorld(input.move, cameraYaw);
  const facing = { x: Math.sin(active.heading), z: Math.cos(active.heading) };
  const aimDir = Math.hypot(moveDir.x, moveDir.z) > 0.2 ? moveDir : facing;
  const hasBall = world.controllerId === active.id;
  const r1 = a.modR1.down;
  const l1 = a.modL1.down;

  if (!hasBall) {
    if (a.switch.pressed || a.modL1.pressed) switchPlayer(world);
    if (a.shoot.pressed) tackle(world, active, r1 ? 1.35 : 1);
    if (a.cross.pressed) slideTackle(world, active);
    return;
  }

  if (a.shoot.released) {
    const charge = chargeOf(a.shoot.heldTime);
    const goal = goalCenter(world, active.side);
    const d = dist(active.pos, goal);
    if (l1) {
      // Chip: little power, plenty of loft, aimed over the keeper.
      const dir = d < 40 ? normalize(sub(goal, active.pos)) : aimDir;
      applyKick(world, active, dir, MIN_SHOT_POWER * (0.6 + charge * 0.35), 4.2);
      world.events.push({ type: 'shot', side: active.side, intensity: charge * 0.6 });
      world.shots[active.side] += 1;
    } else if (d < 40) {
      // Finesse trades power for placement.
      const profile = r1 ? { ...HUMAN_PROFILE, shotAccuracy: 0.99 } : HUMAN_PROFILE;
      shoot(world, active, profile, 1, (r1 ? 0.45 : 0.55) + charge * (r1 ? 0.45 : 0.65));
    } else {
      applyKick(
        world,
        active,
        aimDir,
        MIN_SHOT_POWER + charge * (MAX_SHOT_POWER - MIN_SHOT_POWER),
        r1 ? 0.6 : 1.8,
      );
      world.events.push({ type: 'kick', side: active.side, intensity: charge });
    }
    return;
  }

  if (a.through.released) {
    const charge = chargeOf(a.through.heldTime);
    const lofted = l1 || a.through.doubleTap;
    const option = bestThroughBall(world, active, aimDir) ?? bestPass(world, active, aimDir);
    const spot = option
      ? option.spot
      : { x: active.pos.x + aimDir.x * 22, z: active.pos.z + aimDir.z * 22 };
    kickPass(world, active, spot, HUMAN_PROFILE, (r1 ? 1.15 : 0.85) + charge * 0.5, {
      lift: lofted ? 3.4 : 0,
    });
    return;
  }

  if (a.cross.released) {
    const charge = chargeOf(a.cross.heldTime);
    const ground = a.cross.doubleTap;
    const option = bestCross(world, active);
    const spot = option
      ? option.spot
      : { x: goalCenter(world, active.side).x - world.attackDir[active.side] * 8, z: 0 };
    kickPass(world, active, spot, HUMAN_PROFILE, (r1 ? 1.2 : 0.95) + charge * 0.4, {
      lift: ground ? 0 : l1 ? 5.5 : 3.8,
    });
    return;
  }

  if (a.pass.released) {
    const charge = chargeOf(a.pass.heldTime);
    const lofted = l1 || a.pass.doubleTap;
    const option = bestPass(world, active, aimDir);
    if (option) {
      kickPass(world, active, option.spot, HUMAN_PROFILE, (r1 ? 1.35 : 0.7) + charge * 0.6, {
        lift: lofted ? 3 : 0,
      });
    } else {
      applyKick(
        world,
        active,
        aimDir,
        MIN_PASS_POWER + charge * (MAX_PASS_POWER - MIN_PASS_POWER),
        lofted ? 3 : 0,
      );
      world.events.push({ type: 'kick', side: active.side, intensity: charge });
    }
  }
}

function switchPlayer(world: SimWorld): void {
  const human = world.config.humanSide;
  const ball = ballPos2(world);
  const candidates = world.players
    .filter((p) => p.side === human && p.role !== 'GK' && p.id !== world.activeId)
    .sort((a, b) => dist(a.pos, ball) - dist(b.pos, ball));
  if (candidates.length) world.activeId = candidates[0].id;
}

/**
 * Standing tackle. `commitment` above 1 is the held "hard" tackle: better odds, but the tackler
 * is out of the play for longer when it fails.
 */
function tackle(world: SimWorld, tackler: SimPlayer, commitment = 1, reach = 2.4): void {
  const target = world.players.find((p) => p.id === world.controllerId);
  tackler.kickCooldown = Math.max(tackler.kickCooldown, 0.25 * commitment);
  if (!target || target.side === tackler.side) return;
  const d = dist(tackler.pos, target.pos);
  if (d > reach) return;
  const strength = (tackler.defending + tackler.physical) / 2;
  const resist = (target.dribbling + target.physical) / 2 + (target.shielding ? 12 : 0);
  const odds = clamp(
    (0.35 + (strength - resist) / 120 + (reach - d) * 0.18) * commitment,
    0.08,
    0.94,
  );
  world.events.push({ type: 'tackle', side: tackler.side, intensity: clamp(odds, 0, 1) });
  if (world.rand() > odds) {
    // A missed hard challenge leaves the defender on the floor.
    tackler.kickCooldown = Math.max(tackler.kickCooldown, 0.25 * commitment * 2);
    return;
  }
  const dir = normalize(sub(goalCenter(world, tackler.side), tackler.pos));
  applyKick(world, tackler, dir, 8, 0.4);
  target.kickCooldown = KICK_COOLDOWN * 2;
  world.controllerId = null;
  world.possession = tackler.side;
  autoSwitch(world, tackler);
}

/** Slide tackle: longer reach and a lunge, at the cost of a long recovery either way. */
function slideTackle(world: SimWorld, tackler: SimPlayer): void {
  const lunge = normalize(sub(ballPos2(world), tackler.pos));
  tackler.vel = { x: tackler.vel.x + lunge.x * 3, z: tackler.vel.z + lunge.z * 3 };
  tackle(world, tackler, 1.2, 3.4);
  tackler.kickCooldown = Math.max(tackler.kickCooldown, 0.85);
}
