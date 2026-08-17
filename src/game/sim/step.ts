import {
  ACCELERATION,
  BALL_DAMPING,
  CENTER_CIRCLE_RADIUS,
  BASE_SPEED,
  CONTROL_RADIUS,
  HALF_LENGTH,
  HALF_WIDTH,
  KICK_COOLDOWN,
  PLAYER_RADIUS,
  SPRINT_MULTIPLIER,
  STAMINA_DRAIN_RUN,
  STAMINA_DRAIN_SPRINT,
  STAMINA_RECOVERY,
  TURN_RATE,
} from '../constants';
import {
  CHARGED_ACTIONS,
  type ActionName,
  type InputFrame,
  type InputManager,
} from '../input/input';
import type { TeamSide } from '../types';
import { resolveAerials, updateBodies, updateKeepers, type HeaderIntent } from './aerial';
import {
  decideOffBall,
  decideOnBall,
  kickPass,
  nearestOpponentDistance,
  registerShot,
  shoot,
} from './ai';
import {
  applyKick,
  ballPos2,
  bestCross,
  bestPass,
  bestThroughBall,
  goalCenter,
  ownGoalCenter,
} from './kick';
import {
  angleDelta,
  cameraRelative,
  clamp,
  dist,
  dot,
  normalize,
  smoothing,
  sub,
  type Vec2,
} from './math';
import {
  advanceClock,
  awardFoul,
  checkBallOut,
  flagOffsides,
  halfEndsAt,
  startNextPeriod,
  tickShootout,
  whistleOffside,
} from './rules';
import { aiTakeSetPiece, canTake, findTaker, takePenalty, takerApproach } from './setpiece';
import { applyPendingFormations, applyPendingSubs, maybeAutoSub, subWindowOpen } from './subs';
import { speedFor } from './power';
import { predictFlight } from './ballistics';
import { strike, type ShotStyle, type ShotTake } from './finishing';
import { firstTouchError, performSkill, skillFromDirection } from './skills';
import {
  advanceSwitchTimers,
  manualSwitchHeld,
  rankSwitchCandidates,
  requestSwitch,
  reviewDefensiveSwitch,
} from './switching';
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

const isLive = (world: SimWorld): boolean => world.phase === 'in-play';
const playersMove = (world: SimWorld): boolean =>
  world.phase !== 'end' && world.phase !== 'halftime';

export function tick(
  world: SimWorld,
  input: InputFrame,
  cameraYaw: number,
  dt: number,
  manager: InputManager,
): void {
  world.pendingKickId = null;
  world.shotAge += dt;
  /*
   * The trajectory cache: rebuilt after any strike or deflection, dropped once somebody has the
   * ball at his feet. Built here, at the top of the tick after the event, so the launch
   * velocity it samples is the one the rigid body actually received.
   */
  if (world.flightDirty) {
    world.flight = predictFlight(world.ball.pos, world.ball.vel, world.ball.spin.y);
    world.flightDirty = false;
    world.flightAge = 0;
  } else if (world.controllerId !== null && world.flight) {
    world.flight = null;
  } else if (world.flight) {
    world.flightAge += dt;
  }
  advanceSwitchTimers(world, dt);
  // The face buttons mean different things with and without the ball; publish which it is so
  // the input layer can resolve a press against the state it was made in.
  const human = world.config.humanSide;
  manager.setContext(world.possession === human ? 'ATTACK' : 'DEFENCE');

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
      world.phaseTimer = Math.max(0, world.phaseTimer - dt);
      break;
    case 'goal':
      world.phaseTimer -= dt;
      freezeBall(world);
      if (world.phaseTimer <= 0) {
        const conceded = other(world.lastScorer ?? 'away');
        // Compare against the same end-of-half the clock uses. Testing regulation time here
        // while `advanceClock` tested regulation *plus stoppage* meant a goal scored in added
        // time hit a state where neither branch could make progress, and the match hung in the
        // celebration forever.
        if (world.clock >= halfEndsAt(world)) advanceClock(world, 0);
        else resetToKickoff(world, conceded);
      }
      break;
    case 'halftime':
      world.phaseTimer -= dt;
      if (world.phaseTimer <= 0) startNextPeriod(world);
      break;
    case 'end':
      return;
    default:
      break;
  }

  // Substitutions happen while the ball is dead, never in open play or a shootout.
  if (!world.shootout && subWindowOpen(world)) {
    maybeAutoSub(world);
    applyPendingSubs(world);
    applyPendingFormations(world);
  }

  // A shootout runs outside the match clock; kicks that die out get timed out here.
  if (world.shootout) tickShootout(world, dt);

  if (isLive(world) && !world.shootout) advanceClock(world, dt);
  if (world.phase === 'kickoff') freezeBall(world);
  /*
   * The kickoff is over the moment the ball is genuinely played — it has left the centre circle,
   * or been struck with something on it. Until then the opposition has to stand off, which is
   * the actual law and was not modelled at all: the whistle went and everyone charged.
   */
  if (world.kickoffProtected) {
    const moved = Math.hypot(world.ball.pos.x, world.ball.pos.z) > CENTER_CIRCLE_RADIUS;
    const struck = Math.hypot(world.ball.vel.x, world.ball.vel.z) > 2.5;
    if (world.phase === 'in-play' && (moved || struck)) world.kickoffProtected = false;
    else if (world.phase !== 'in-play' && world.phase !== 'kickoff') world.kickoffProtected = false;
  }

  updateBodies(world, dt);

  if (playersMove(world)) {
    updatePlayers(world, input, cameraYaw, dt);
    resolveOverlaps(world, dt);
  }

  if (world.phase === 'restart') updateRestart(world, input, cameraYaw, dt, manager);

  if (isLive(world)) {
    resolveChallenges(world, dt);
    resolveAerials(world, headerIntent(world, input, cameraYaw));
    updateKeepers(world, dt);
    updateControl(world, dt);
    // Manual switching is read before the action handler so the new man acts this same tick.
    /*
     * Holding jockey while defending sends the keeper out. It is the same "engage" meaning the
     * button already has for outfield players, and there was previously no way at all to bring
     * him off his line for a through ball.
     */
    world.keeperRush = input.actions.jockey.down && world.possession !== world.config.humanSide;
    resolvePendingSwitch(world);
    if (input.actions.switch.pressed) requestSwitch(world);
    else reviewDefensiveSwitch(world);
    handleHumanActions(world, input, cameraYaw, manager);
    releaseBuffered(world, input, cameraYaw, manager);
    if (world.possession) world.possessionTicks[world.possession] += 1;
    checkBallOut(world);
  }

  settleKick(world);
}

/** Offside is judged from the moment the ball was last struck, so it resolves after the tick. */
function settleKick(world: SimWorld): void {
  if (world.pendingKickId === null) return;
  const kicker = world.players.find((p) => p.id === world.pendingKickId);
  if (kicker) flagOffsides(world, kicker);
  world.pendingKickId = null;
  // Any subsequent phase of play is judged for offside, including from a set piece.
  world.offsideActive = true;
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
    if (p.sentOff) continue;
    const hasBall = world.controllerId === p.id;
    p.kickCooldown = Math.max(0, p.kickCooldown - dt);

    // A diving keeper and a player mid-skill are committed: no steering until they land.
    if (p.anim === 'dive' || p.skillTimer > 0.15) {
      p.pos.x += p.vel.x * dt;
      p.pos.z += p.vel.z * dt;
      p.vel = { x: p.vel.x * 0.92, z: p.vel.z * 0.92 };
      continue;
    }

    let desired: Vec2;
    let sprint: boolean;
    let face: Vec2 | null = null;

    const set = world.restart;
    if (set && world.phase === 'restart' && p.id === set.takerId) {
      // The taker walks up to the ball and waits there, whoever is controlling him.
      const spot = takerApproach(world, set);
      const to = sub(spot, p.pos);
      const d = Math.hypot(to.x, to.z);
      const n = normalize(to);
      desired = { x: n.x * clamp(d / 1.5, 0, 1), z: n.z * clamp(d / 1.5, 0, 1) };
      sprint = d > 8;
      face = sub(set.spot, p.pos);
      integrate(p, desired, sprint, dt, face, false);
      continue;
    }

    if (world.phase === 'goal' && world.lastScorer) {
      celebrate(world, p, dt);
      continue;
    }

    /*
     * A planned AI strike: hold the backswing, then hit it. Cancelled the instant the ball is
     * no longer his — a wound-up player whose ball has been poked away swings at nothing.
     */
    if (p.plannedShot && p.id !== humanControlled) {
      /*
       * Cancel only when the ball is genuinely gone — another man on it, possession turned, or
       * play dead. The first cut cancelled whenever `controllerId !== p.id`, and the touch
       * scheduler flickers that to null on every knock-ahead, so nearly every planned strike
       * died mid-backswing: AI shot counts collapsed and matches decayed into goal-mouth
       * scrambles.
       */
      const stolen = world.controllerId !== null && world.controllerId !== p.id;
      const gone = dist(p.pos, ballPos2(world)) > 2.2;
      if (stolen || gone || world.possession !== p.side || !isLive(world)) {
        p.plannedShot = null;
      } else {
        p.plannedShot.at -= dt;
        p.windup = clamp(1 - p.plannedShot.at / 0.34, 0, 1);
        // Planting, not dribbling: the shooter sets his feet through the swing.
        p.intent = { x: p.intent.x * 0.25, z: p.intent.z * 0.25 };
        if (p.plannedShot.at <= 0) {
          const quality = p.plannedShot.quality;
          p.plannedShot = null;
          shoot(world, p, profileFor(world, p), quality);
        }
      }
    }

    if (p.id === humanControlled) {
      // Out of possession the pass button jockeys and the shoot button closes the carrier down;
      // the pad's dedicated jockey trigger still works either way.
      const jockey = !hasBall && (input.actions.pass.down || input.actions.jockey.down);
      const closeDown = !hasBall && input.actions.shoot.down;
      p.shielding = jockey;
      desired = cameraRelative(input.move, cameraYaw);
      if (closeDown) desired = containTarget(world, p);
      if (jockey) {
        desired = { x: desired.x * 0.55, z: desired.z * 0.55 };
        face = sub(ballPos2(world), p.pos);
      }
      sprint = input.actions.sprint.down && !jockey && !closeDown && p.stamina > 0.05;
    } else {
      // Only the carrier shields; decideOnBall re-arms this on its own cadence.
      if (world.controllerId !== p.id) p.shielding = false;
      const profile = profileFor(world, p);
      p.thinkTimer -= dt;
      const carrying = world.controllerId === p.id && isLive(world) && p.holdTimer <= 0;
      if (p.thinkTimer <= 0) {
        // Keepers and the ball carrier re-decide faster than the rest of the team.
        const cadence = p.role === 'GK' || world.controllerId === p.id ? 0.4 : 1;
        p.thinkTimer = profile.reaction * cadence * (0.75 + world.rand() * 0.5) + 0.02;
        if (carrying) decideOnBall(world, p, profile);
        else decideOffBall(world, p, profile);
      } else if (carrying) {
        // Keep steering towards goal between decisions so dribbling stays smooth.
        const goal = goalCenter(world, p.side);
        p.intent = normalize(sub(goal, p.pos));
      }
      desired = p.intent;
      sprint = p.intentSprint && p.stamina > 0.08;
      face = p.intentFace;
    }

    integrate(p, desired, sprint, dt, face, hasBall);
  }
}

/** After a goal the scorer wheels away and his team chases him down. */
function celebrate(world: SimWorld, p: SimPlayer, dt: number): void {
  const scorer = world.players.find((s) => s.id === world.lastScorerId);
  if (p.side !== world.lastScorer || !scorer) {
    integrate(p, { x: 0, z: 0 }, false, dt, null, false);
    return;
  }
  if (p.id === scorer.id) {
    // Off towards the corner flag with the arms up.
    const corner = {
      x: goalCenter(world, p.side).x * 0.82,
      z: Math.sign(p.pos.z || 1) * (HALF_WIDTH - 4),
    };
    const to = sub(corner, p.pos);
    const d = Math.hypot(to.x, to.z);
    const n = normalize(to);
    p.anim = 'celebrate';
    p.animTimer = 1;
    integrate(
      p,
      { x: n.x * clamp(d / 3, 0, 1), z: n.z * clamp(d / 3, 0, 1) },
      d > 6,
      dt,
      null,
      false,
    );
    return;
  }
  const to = sub(scorer.pos, p.pos);
  const d = Math.hypot(to.x, to.z);
  const n = normalize(to);
  integrate(
    p,
    { x: n.x * clamp((d - 2) / 3, 0, 1), z: n.z * clamp((d - 2) / 3, 0, 1) },
    d > 12,
    dt,
    null,
    false,
  );
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
  hasBall: boolean = false,
): void {
  const throttle = Math.min(1, Math.hypot(desired.x, desired.z));
  const dir = normalize(desired);
  const staminaFactor = 0.72 + 0.28 * clamp(p.stamina * 1.4, 0, 1);
  // Keepers shuffle and dive rather than sprint across their line.
  const maxSpeed =
    BASE_SPEED *
    (0.78 + (p.pace / 100) * 0.44) *
    (sprint ? SPRINT_MULTIPLIER : 1) *
    // Being leant on is heavy: a jostled man cannot run at full tilt.
    (0.55 + 0.45 * p.balance) *
    staminaFactor *
    (p.shielding ? 0.72 : 1) *
    (p.role === 'GK' ? 0.78 : 1) *
    // Running with the ball costs top speed; clean technicians lose less of it.
    (hasBall ? 0.84 + p.dribbling / 800 : 1);
  const target = { x: dir.x * maxSpeed * throttle, z: dir.z * maxSpeed * throttle };

  const dvx = target.x - p.vel.x;
  const dvz = target.z - p.vel.z;
  const dv = Math.hypot(dvx, dvz);
  const entryVel = { x: p.vel.x, z: p.vel.z };
  const entrySpeed = Math.hypot(entryVel.x, entryVel.z);

  // Base acceleration scaled by dribbling; forward thrust stays strong because
  // sprinting is a straight-line commitment, not a sluggishness.
  const accel = ACCELERATION * (0.82 + p.dribbling / 320);

  if (entrySpeed > 0.3 && dv > 1e-5) {
    // Resolve the velocity change in the player's moving frame so we can give
    // different traction in each axis. At speed he cannot cut like a cursor:
    // lateral force collapses as speed rises, and sprinting narrows it further.
    const velDir = { x: p.vel.x / entrySpeed, z: p.vel.z / entrySpeed };
    const side = { x: velDir.z, z: -velDir.x };
    const dvDir = { x: dvx / dv, z: dvz / dv };

    const along = dot(dvDir, velDir);
    const lateral = dot(dvDir, side);

    const sprintRatio = clamp(entrySpeed / (BASE_SPEED * SPRINT_MULTIPLIER), 0, 1);
    const sprintPenalty = sprint ? 0.55 : 1;

    // Base side-to-side traction, improved by dribbling.
    const lateralBase = 0.35 + p.dribbling / 300;

    const maxForward = accel * dt * (sprint ? 0.9 : 1);
    const maxBrake = accel * dt * 1.25 * sprintPenalty;
    const maxLateral = accel * dt * lateralBase * sprintPenalty * (1 - sprintRatio * 0.45);

    const stepForward =
      along >= 0 ? Math.min(along * dv, maxForward) : Math.max(along * dv, -maxBrake);
    const stepLateral = clamp(lateral * dv, -maxLateral, maxLateral);

    p.vel.x += velDir.x * stepForward + side.x * stepLateral;
    p.vel.z += velDir.z * stepForward + side.z * stepLateral;
  } else if (dv > 1e-5) {
    // Standing or very slow: choose direction freely with full acceleration.
    const step = Math.min(dv, accel * dt);
    p.vel.x += (dvx / dv) * step;
    p.vel.z += (dvz / dv) * step;
  }

  // The smoothed acceleration the renderer leans the body into.
  if (dt > 0) {
    const k = smoothing(dt, 0.12);
    p.accelSmooth.x += ((p.vel.x - entryVel.x) / dt - p.accelSmooth.x) * k;
    p.accelSmooth.z += ((p.vel.z - entryVel.z) / dt - p.accelSmooth.z) * k;
  }

  p.pos.x = clamp(p.pos.x + p.vel.x * dt, -HALF_LENGTH - 2.5, HALF_LENGTH + 2.5);
  p.pos.z = clamp(p.pos.z + p.vel.z * dt, -HALF_WIDTH - 2.5, HALF_WIDTH + 2.5);

  const speed = Math.hypot(p.vel.x, p.vel.z);
  // Phase advances with distance covered, so strides never skate over the grass.
  /*
   * Stride cadence grows with the square root of speed, not linearly: runners lengthen their
   * stride at pace far more than they quicken it. The old linear advance was calibrated at a
   * jog, so a sprinter's legs pumped about 7.5 steps a second — half again the real ~5 — which
   * is most of what made sprinting look sped-up. Calibrated to leave the jog unchanged.
   */
  p.gait = (p.gait + (Math.sqrt(Math.max(speed, 0.05)) * dt) / 0.385) % (Math.PI * 2);
  const facing = face && Math.hypot(face.x, face.z) > 0.01 ? face : speed > 0.35 ? p.vel : null;
  if (facing) {
    const want = Math.atan2(facing.x, facing.z);
    // Turning is inversely coupled to how fast he is actually going. At a walk he can pivot on
    // the spot; at full sprint the turning circle is metres wide, which is what stops players
    // changing direction like cursors.
    const pace = clamp(speed / (BASE_SPEED * SPRINT_MULTIPLIER), 0, 1);
    /*
     * The pace coupling models a *change of travel direction* — you cannot cut at sprint. But an
     * explicit facing target is the torso turning to watch the ball while the feet keep their
     * line, which costs almost nothing: throttling it welded every defender's eyes to his
     * toes and made side-on containment physically impossible.
     */
    const throttle = face && Math.hypot(face.x, face.z) > 0.01 ? 0.15 : 0.68;
    const rate = TURN_RATE * (0.85 + p.dribbling / 400) * (1 - pace * throttle);
    p.heading += clamp(angleDelta(p.heading, want), -rate * dt, rate * dt);
  }

  /*
   * Stamina only recovered when a player was standing perfectly still, and *jogging drained it*.
   * Nobody in a football match stands still, so stamina fell monotonically for ninety minutes and
   * a player who had sprinted was finished for the rest of the game.
   *
   * Real recovery happens at low intensity. Sprinting costs, running hard costs a little, and
   * anything at a jog or below pays it back.
   */
  // Balance recovers in space; the drain lives in the jostle inside resolveOverlaps.
  p.balance = clamp(p.balance + 0.5 * dt, 0, 1);

  const endurance = 0.6 + (p.enduranceRating / 100) * 0.6;
  const intensity = clamp(speed / (BASE_SPEED * SPRINT_MULTIPLIER), 0, 1);
  if (sprint && speed > 1) p.stamina -= (STAMINA_DRAIN_SPRINT / endurance) * dt;
  else if (intensity > 0.62) p.stamina -= (STAMINA_DRAIN_RUN / endurance) * dt;
  else p.stamina += STAMINA_RECOVERY * endurance * (1 - intensity * 0.7) * dt;
  p.stamina = clamp(p.stamina, 0, 1);
}

/**
 * Players are kinematic bodies, so they need a cheap separation pass of their own.
 *
 * Two things were wrong here. The separation distance was the *collider* radius, which is
 * narrower than the shoulders that actually get drawn, so players visibly stood inside one
 * another. And a single pass cannot resolve a cluster — pushing A off B shoves it into C — so
 * knots of players around the six-yard box never came apart. A few relaxation iterations fix
 * that for a handful of microseconds.
 */
const SEPARATION = PLAYER_RADIUS * 2.5;

function resolveOverlaps(world: SimWorld, dt: number): void {
  const min = SEPARATION;
  const ball = ballPos2(world);
  const players = world.players.filter((p) => !p.sentOff);
  for (let pass = 0; pass < 3; pass++) {
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
        /*
         * The jostle. Opponents leaning on each other near the ball drain balance from the
         * weaker man — the physical differential sets the rate, shielding blunts it. This is
         * the contact channel: it does not knock anyone over, it makes the pressed man slower
         * and sloppier until he is genuinely muscled off the ball.
         */
        if (pass === 0 && a.side !== b.side && dt > 0) {
          const nearBall = dist(a.pos, ball) < 3 || dist(b.pos, ball) < 3;
          if (nearBall) {
            const edge = (b.physical - a.physical) / 60;
            const drainA = Math.max(0.12, 0.55 + edge) * (a.shielding ? 0.55 : 1);
            const drainB = Math.max(0.12, 0.55 - edge) * (b.shielding ? 0.55 : 1);
            a.balance = clamp(a.balance - drainA * dt, 0, 1);
            b.balance = clamp(b.balance - drainB * dt, 0, 1);
          }
        }
      }
    }
  }
}

/** Pace a ground pass should still carry when it reaches its man, m/s. */
const PASS_ARRIVAL_SPEED = 4.5;
/** How much pace a rolling ball sheds per metre travelled. */
const PASS_DECAY_PER_METRE = 0.62;
/** A runner meets a through ball at pace, so it needs less left on it than a ball to feet. */
const THROUGH_ARRIVAL_SPEED = 3.2;

/**
 * Speed to play a ball `range` metres and have it arrive with something still on it. A rolling
 * ball sheds pace close to linearly with distance, so this is a good closed form.
 *
 * `charge` says how he strikes it, not whether it gets there: a tap is a properly weighted ball,
 * leaning on it drives the same pass. `sloppiness` mis-weights it for a poor or rushed passer.
 */
function weightedPassSpeed(
  range: number,
  charge: number,
  arrival: number,
  sloppiness: number,
  rand: () => number,
): number {
  const weighted = arrival + range * PASS_DECAY_PER_METRE;
  const misweight = 1 + (rand() + rand() - 1) * sloppiness * 0.42;
  return weighted * (0.95 + charge * 0.5) * misweight;
}

/**
 * Launch that carries a lofted ball `range` metres at `theta` radians. In a vacuum
 * `v = sqrt(R * g / sin(2 * theta))`; the ball's drag costs a little more than that.
 *
 * Every lofted delivery in the game used to take its speed from hold time and *then* split it
 * into an angle, which meant a light press had almost no horizontal pace left and the ball fell
 * out of the sky after a few metres. Solve the launch for the distance instead.
 */
function loftedLaunch(
  range: number,
  theta: number,
  charge: number,
  sloppiness: number,
  rand: () => number,
  cap: number,
): { speed: number; lift: number } {
  const needed = Math.sqrt((range * 9.81) / Math.max(0.2, Math.sin(2 * theta))) * 1.12;
  const misweight = 1 + (rand() + rand() - 1) * sloppiness * 0.35;
  const v = clamp(needed * (0.95 + charge * 0.35) * misweight, 6, cap);
  return { speed: v * Math.cos(theta), lift: v * Math.sin(theta) };
}

/** How badly a passer is likely to mis-hit it, from his passing and how closely he is pressed. */
function passSloppiness(world: SimWorld, p: SimPlayer): number {
  const rushed = clamp(1 - nearestOpponentDistance(world, p) / 5, 0, 1);
  return (1 - p.passing / 100) * (0.5 + rushed * 0.9);
}

const CHALLENGE_RADIUS = 1.4;

/**
 * Defenders cannot simply out-reach a dribbler (the ball is glued to his feet), so closing
 * a carrier down wins the ball probabilistically — defending rating versus the carrier's pace.
 * Mistimed challenges are fouls.
 */
function resolveChallenges(world: SimWorld, dt: number): void {
  const carrier = world.players.find((p) => p.id === world.controllerId);
  if (!carrier || carrier.sentOff) return;
  // A keeper with the ball in his gloves cannot be challenged.
  if (carrier.role === 'GK' && carrier.holdTimer > 0) return;
  for (const opponent of world.players) {
    if (opponent.side === carrier.side || opponent.kickCooldown > 0 || opponent.sentOff) continue;
    // A keeper spreads himself at a forward's feet, so he covers more ground than a tackle.
    const radius = opponent.role === 'GK' ? 3 : CHALLENGE_RADIUS;
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

    // Coming in quickly with poor technique catches the man instead of the ball.
    const closingSpeed = Math.hypot(opponent.vel.x - carrier.vel.x, opponent.vel.z - carrier.vel.z);
    const clumsy = clamp(0.3 - opponent.defending / 260 + closingSpeed * 0.018, 0.02, 0.4);
    if (opponent.role !== 'GK' && world.rand() < clumsy) {
      awardFoul(world, opponent, carrier, {
        severity: clamp(closingSpeed / 9 + (opponent.physical - 60) / 200, 0.15, 1),
      });
      return;
    }

    carrier.kickCooldown = KICK_COOLDOWN * 1.6;
    opponent.tally.tackles += 1;
    opponent.anim = 'tackle';
    opponent.animTimer = 0.3;
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
function updateControl(world: SimWorld, dt: number): void {
  const ball = ballPos2(world);
  const previous = world.controllerId;
  const ballSpeed = Math.hypot(world.ball.vel.x, world.ball.vel.z);

  // A keeper with the ball in his gloves keeps it until he is ready to distribute.
  const keeperHolding = world.players.find(
    (p) => p.id === previous && p.role === 'GK' && p.holdTimer > 0,
  );
  if (keeperHolding) {
    // He gets up and carries it out of the six-yard box before looking for a teammate.
    const own = ownGoalCenter(world, keeperHolding.side);
    const out = Math.sign(-own.x || 1);
    keeperHolding.anim = keeperHolding.anim === 'dive' ? 'run' : keeperHolding.anim;
    keeperHolding.diveDir = 0;
    keeperHolding.pos.x = clamp(
      keeperHolding.pos.x + out * 3 * dt,
      Math.min(own.x, own.x + out * 7),
      Math.max(own.x, own.x + out * 7),
    );
    keeperHolding.pos.z += clamp(-keeperHolding.pos.z, -2 * dt, 2 * dt);
    const vel = { x: 0, y: 0, z: 0 };
    world.ball.vel = vel;
    world.commands.push({ type: 'velocity', vel });
    world.commands.push({
      type: 'teleport',
      pos: { x: keeperHolding.pos.x, y: 0.9, z: keeperHolding.pos.z },
    });
    return;
  }

  let holder: SimPlayer | null = null;
  let bestD = Infinity;
  let blocker: SimPlayer | null = null;
  for (const p of world.players) {
    if (p.kickCooldown > 0 || p.sentOff) continue;
    const keeper = p.role === 'GK';
    // A man whose own team played the ball is expecting it, so he stretches for it and
    // takes it at pace; an opponent has to read it, and can only nick a firmly struck ball.
    const expecting = p.side === world.possession;
    // A carrier still owns the ball he has just knocked ahead: possession is "can I get there
    // first", not "is it inside arm's length". Without this the touch scheduler loses the ball
    // to nobody every time it pushes it in front.
    // Nobody may nick the ball off the side taking the kickoff before they have played it.
    if (world.kickoffProtected && p.side !== world.kickoffSide) continue;
    const carrying = p.id === previous && p.kickCooldown <= 0;
    const reach = CONTROL_RADIUS + (keeper ? 0.55 : expecting ? 0.25 : 0) + (carrying ? 1.15 : 0);
    const height = keeper ? 2.6 : 1.5;
    if (world.ball.pos.y > height) continue;
    const d = dist(p.pos, ball);
    if (d >= reach) continue;
    // A struck ball cannot simply be plucked out of the air: keepers claim all but the
    // hardest strikes, opponents can only nick a firm one at point-blank range.
    //
    // A team-mate expecting the ball must be able to take *any* pass his own side can strike,
    // or a full-power pass sails straight through him as though he were not there. The cost of
    // pace is a heavier first touch (`firstTouchError` below), not an uncontrollable ball.
    // Interception difficulty must come from *position and reaction*, not from a cap that makes
    // the ball untouchable to one team. An opponent used to top out at ~15 m/s against a
    // team-mate's 28, so any pass above half charge was physically un-interceptable and
    // completion sat at 100%. He reads it later and controls it worse; he is not made of glass.
    /*
     * The keeper's catch is a probability, not a cliff. A hard 18 m/s limit meant everything
     * above it parried and everything below it stuck, so rebounds arrived in two flavours only.
     */
    // Deterministic: rolling the dice here consumed RNG every tick for every candidate and
    // shifted every seeded scenario downstream of it. The attribute does the scaling instead.
    const keeperCatch = keeper ? 14 + (p.defending / 100) * 10 : 0;
    const limit = keeper ? keeperCatch : (expecting ? 28 : 22) + (p.defending + p.dribbling) / 40;
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
      world.rand() > clamp(1.35 - ballSpeed / limit, 0.25, 1)
    ) {
      continue;
    }
    if (d < bestD) {
      bestD = d;
      holder = p;
    }
  }

  if (!holder && blocker) {
    /*
     * A block is a collision, not an event with an authored outcome.
     *
     * This used to reverse a quarter of the incoming velocity and add a flat 3 m/s along a
     * vector that — despite its name — pointed *into* the man who had just blocked it. The
     * rebound barely depended on the shot: a 45 m/s strike came back at 7 m/s and a 15 m/s one
     * resolved to 0.7 m/s and died at his feet. It could never pop up, carried no spin, and was
     * identical every time. Second-phase play simply did not exist.
     *
     * Now it reflects about the contact normal with a restitution that depends on which part of
     * him it hit, so pace off the block scales with pace onto it.
     */
    const contactY = world.ball.pos.y;
    // Lower contacts are boot and shin — hard surfaces that spring the ball away. Higher up it
    // is thigh and midriff, which absorb it.
    const restitution =
      contactY < 0.35 ? 0.55 : contactY < 0.9 ? 0.5 : contactY < 1.35 ? 0.42 : 0.32;

    // The ball meets a moving limb, not a plane. Jitter the normal so ricochets are chaotic —
    // lawfully so, rather than the same rebound every time.
    const base = normalize(sub(ball, blocker.pos));
    const jitter = (world.rand() * 2 - 1) * 0.3;
    const cj = Math.cos(jitter);
    const sj = Math.sin(jitter);
    const n = { x: base.x * cj - base.z * sj, z: base.x * sj + base.z * cj };

    const v = world.ball.vel;
    const along = v.x * n.x + v.z * n.z;
    const speed = Math.hypot(v.x, v.z);
    // Split the impact: only the component *into* the defender is absorbed by him. The component
    // sliding across him is barely slowed. Damping the whole reflected vector by the restitution
    // — as though he absorbed the sideways motion too — is what leaves rebounds limp.
    const nx = v.x - along * n.x;
    const nz = v.z - along * n.z;
    let rx = nx * 0.82 - along * n.x * restitution;
    let rz = nz * 0.82 - along * n.z * restitution;
    // A defender braced against the shot pushes it back a little; his own momentum counts too.
    rx += n.x * speed * 0.08 + blocker.vel.x * 0.25;
    rz += n.z * speed * 0.08 + blocker.vel.z * 0.25;

    // Struck low into a boot or shin, the ball balloons. Off the body it stays down.
    const lowness = clamp(1 - contactY / 1.4, 0, 1);
    const lift = Math.abs(v.y) * 0.35 + speed * 0.13 * lowness * (0.6 + world.rand() * 0.8);

    const vel = { x: rx, y: lift, z: rz };
    world.ball.vel = vel;
    // Tangential contact puts spin on it, so a deflection can curl away awkwardly.
    const tangential = v.x * -n.z + v.z * n.x;
    world.ball.spin = { x: 0, y: clamp(tangential * 0.04, -1.5, 1.5), z: 0 };
    world.commands.push({ type: 'velocity', vel });
    world.lastTouch = { side: blocker.side, playerId: blocker.id };
    blocker.kickCooldown = KICK_COOLDOWN * 0.8;
    world.events.push({ type: 'tackle', side: blocker.side, intensity: clamp(speed / 30, 0.2, 1) });
    world.controllerId = null;
    /*
     * A deflection is *nobody's* ball. Possession used to stay with the shooting side, so their
     * team kept running attacking support shapes, the defenders kept their block, and the
     * rebound died untouched — measured as 15 of 15 rebounds falling to no one. With possession
     * open, both teams' AI treats it as a ball to be won.
     */
    world.possession = null;
    world.flightDirty = true;
    return;
  }

  world.controllerId = holder ? holder.id : null;
  if (!holder) return;
  // Somebody has it: the ball is no longer "on its way" to anyone. Remember who it was meant
  // for first, so control can follow a completed pass.
  const wasPlayedTo = world.passTarget?.playerId ?? null;
  world.passTarget = null;

  // The linesman's flag: a player played onside stays onside, one caught beyond the line does not.
  if (holder.offside && world.offsideActive) {
    whistleOffside(world, holder);
    return;
  }

  let touch: Vec2 = { x: 0, z: 0 };
  if (previous !== holder.id) {
    if (holder.role === 'GK' && ballSpeed > 12) {
      world.events.push({
        type: 'save',
        side: holder.side,
        intensity: clamp(ballSpeed / 25, 0, 1),
      });
    }
    // Control follows a completed pass. Switching only on a change of *possession* meant that
    // playing the ball to your own team-mate left you steering the man who had just passed it
    // while somebody else ran off with it. Deliberately narrow: only the man the ball was
    // actually played to, never the keeper, and never on a scrappy re-take.
    const receivedOurPass =
      holder.side === world.config.humanSide && holder.role !== 'GK' && wasPlayedTo === holder.id;
    if (receivedOurPass || world.possession !== holder.side) autoSwitch(world, holder);
    // First touch: a hard pass bounces off a poor technician.
    touch = firstTouchError(world, holder, ballSpeed);
  }
  world.possession = holder.side;
  world.lastTouch = { side: holder.side, playerId: holder.id };
  for (const p of world.players) p.offside = false;

  dribbleTouch(world, holder, ball, touch, dt);
}

/**
 * The touch scheduler.
 *
 * The ball used to be *kinematically attached* to the carrier: its velocity was overwritten
 * every single tick to hold it at a spot in front of him. That is why it never looked like it
 * was being played — it moved as a staircase of commanded velocities rather than rolling, it
 * could not be tackled between touches because it was glued, and a shot was a discontinuous
 * hand-off from "driven by code" to "driven by physics" that read as the ball teleporting up to
 * speed.
 *
 * Now the ball is only ever a rigid body. Possession means the carrier gets to *touch* it: a
 * discrete impulse, timed, that sends it to where his next touch expects it. Between touches it
 * rolls free under friction — genuinely loose, genuinely tackleable — which is what makes a
 * knock-on at sprint a real risk rather than a scripted one.
 */
function dribbleTouch(
  world: SimWorld,
  holder: SimPlayer,
  ball: Vec2,
  touch: Vec2,
  dt: number,
): void {
  holder.touchTimer -= dt;
  const speed = Math.hypot(holder.vel.x, holder.vel.z);

  // Where he intends to go, not where he currently is: this is what makes control responsive.
  const heading = { x: Math.sin(holder.heading), z: Math.cos(holder.heading) };
  /*
   * How far in front the ball sits. This is the single most important number in dribbling and it
   * has to have real dynamic range: tucked under you at a walk, pushed properly into space at a
   * sprint. It was previously ~0.6 m walking and only ~1.05 m running, which felt simultaneously
   * too far at a jog and not committed enough at a sprint.
   *
   * A better dribbler keeps it tighter at any given pace, which is what the attribute should buy.
   */
  /*
   * Attribute response, deliberately superlinear at the top. Driving everything off
   * `dribbling / 100` made a 90 barely distinguishable from a 70 — 11% tighter control and a 13%
   * bigger touch budget. Elite close control is a different category, not a bit more of the same
   * thing, so the curve is weighted so the last twenty points of the attribute buy roughly as
   * much as the forty below them.
   *
   *   dribbling 50 -> 0.14    70 -> 0.41    90 -> 0.78
   */
  const skill = Math.pow(clamp((holder.dribbling - 30) / 70, 0, 1), 1.6);
  const tightness = 1.4 - skill * 0.75;
  const control = (0.28 + (1 - skill) * 0.2) * tightness;
  /*
   * Superlinear in pace, and deliberately *not* keyed off a sprint flag. A boolean threshold sat
   * right on top of normal running speed, so the knock flickered between its walking and
   * sprinting values several times a second and the ball juddered. Growing with speed^2.4 gives
   * the same "tucked under you at a walk, pushed into space at a sprint" separation with no
   * discontinuity to fall over.
   */
  const knock = Math.min(2.2, control + Math.pow(speed, 2.4) * 0.0045 * tightness);

  /*
   * A good dribbler is agile on the turn. When the carrier cuts hard away from the way the ball
   * is rolling, he can take it with the outside of the boot and keep it under him instead of
   * letting it run — a bigger impulse budget, a tighter target, and a flourish on the animation.
   * Poor dribblers simply do not get this, so the ball runs away from them on the same cut.
   */
  const ballDir = Math.hypot(world.ball.vel.x, world.ball.vel.z) > 1.5 ? world.ball.vel : null;
  let cutting = false;
  let cutTurn = 0;
  if (ballDir) {
    const bl = Math.hypot(ballDir.x, ballDir.z);
    const turn = Math.acos(
      clamp(
        (Math.sin(holder.heading) * ballDir.x + Math.cos(holder.heading) * ballDir.z) / bl,
        -1,
        1,
      ),
    );
    // No cliff: a sharper player can take it away on a shallower angle, and gets more out of it.
    // This used to be a hard gate at `dribbling > 62`, so 61 got nothing and 63 got everything.
    cutting = turn > 1.45 - skill * 0.72 && skill > 0.18 && holder.skillTimer <= 0;
    cutTurn = turn;
  }
  // How long until the next contact. Sprinting strides are longer, so touches are rarer.
  const interval = clamp(knock / Math.max(2.5, speed), 0.18, 0.55);

  const offset = sub(ball, holder.pos);
  const gap = Math.hypot(offset.x, offset.z);
  const alongHeading = offset.x * heading.x + offset.z * heading.z;
  // Out of the envelope, behind him, or the ball is rolling somewhere he is not going.
  const strayed = gap > knock * 1.9 || alongHeading < -0.15 || gap < 0.18;
  if (holder.touchTimer > 0 && !strayed) return;

  // Where the next touch expects to meet it, and the speed that gets it there under friction.
  const reach = cutting ? Math.min(knock, 0.62 - skill * 0.22) : knock;
  const next = {
    x: holder.pos.x + holder.vel.x * interval + heading.x * reach + touch.x,
    z: holder.pos.z + holder.vel.z * interval + heading.z * reach + touch.z,
  };
  const to = sub(next, ball);
  // Rapier's damping bleeds a little pace off over the interval; ask for enough to arrive.
  const carry = 1 + BALL_DAMPING * interval;
  const want = { x: (to.x / interval) * carry, z: (to.z / interval) * carry };

  // A touch can only do so much. Trying to redirect a fast ball through a sharp angle exceeds
  // what a foot can impart, the clamp bites, and the ball runs away from him — the heavy touch
  // falls out of the physics instead of being rolled for.
  const dvx = want.x - world.ball.vel.x;
  const dvz = want.z - world.ball.vel.z;
  const dv = Math.hypot(dvx, dvz);
  const maxTouch = (5 + skill * 11) * (cutting ? 1 + skill * 1.5 : 1);
  const scale = dv > maxTouch ? maxTouch / dv : 1;

  /*
   * Touch error, applied to the *desired* velocity so it always stays within what a foot could
   * lawfully do. Without it every touch was perfect and the only way to lose the ball was the
   * impulse clamp — which is why a poor dribbler did not feel poor. It grows with pace and with
   * how sharply he is trying to turn the ball, and all but vanishes for an elite carrier.
   */
  const sharpness = clamp(cutTurn / Math.PI, 0, 1);
  // A man being leant on plays heavier touches: the jostle feeds straight into ball control.
  const duress = 1 + (1 - holder.balance) * 1.4;
  const spread = (1 - skill) * 0.3 * (0.35 + speed / 11) * (1 + sharpness * 1.1) * duress;
  const wobble = (world.rand() + world.rand() - 1) * spread;
  const cw = Math.cos(wobble);
  const sw = Math.sin(wobble);
  const ex = dvx * cw - dvz * sw;
  const ez = dvx * sw + dvz * cw;
  const vel = {
    x: world.ball.vel.x + ex * scale,
    y: world.ball.vel.y,
    z: world.ball.vel.z + ez * scale,
  };
  world.ball.vel = vel;
  world.commands.push({ type: 'velocity', vel });
  holder.touchTimer = cutting ? interval * 0.7 : interval;
  if (cutting) {
    // A quick touch to take it away from the defender: show it.
    holder.anim = 'skill';
    holder.animTimer = 0.22;
  }
}

/**
 * Hands the human the most useful player when possession flips — unless he has just switched
 * by hand, in which case his intent wins for a moment.
 */
function autoSwitch(world: SimWorld, holder: SimPlayer): void {
  if (manualSwitchHeld(world)) return;
  const human = world.config.humanSide;
  if (holder.side === human) {
    // Control follows the ball to whoever receives it.
    if (holder.role !== 'GK') world.activeId = holder.id;
    return;
  }
  // The ball has gone to the opposition, so rank for defending — goal-side cover counts — even
  // though `world.possession` has not caught up yet. Never hand the player his goalkeeper
  // unasked; pressing switch inside your own box still offers him (§3.1).
  const best = rankSwitchCandidates(world, false, true)[0];
  if (best) world.activeId = best.id;
}

/** A throw is an arm, not a boot: about twenty metres flat out for a strong thrower. */
const THROW_MAX_RANGE = 22;

/**
 * Two hands from above the head. Reuses the ordinary kick path — an earlier attempt at a bespoke
 * launch put the match into an endless restart loop — but with a throw's arc, a throw's range and
 * a throw's animation, and it cannot be a shot.
 */
function throwIn(world: SimWorld, taker: SimPlayer, aim: Vec2, charge: number): void {
  const range = 6 + clamp(charge, 0, 1) * (THROW_MAX_RANGE - 6) * (0.75 + taker.physical / 400);
  const theta = 0.6;
  const v = Math.sqrt((range * 9.81) / Math.sin(2 * theta)) * 1.05;
  applyKick(world, taker, aim, v * Math.cos(theta), v * Math.sin(theta), 0, 'kick');
  taker.anim = 'throw';
  taker.animTimer = 0.5;
  world.events.push({ type: 'throw', side: taker.side, intensity: clamp(charge, 0.2, 1) });
}

/**
 * How the shot is being taken. Every strike used to be treated as a settled, plant-foot finish
 * whether the man was flat out, mid-turn, or hitting a bouncing ball — and that sameness is most
 * of what was left between this and real shooting feel. The classification keys the error and
 * power tables in `strike`, and volleys carry the contact height so a rising half-volley blazes.
 */
function classifyShot(world: SimWorld, p: SimPlayer): ShotTake {
  const ballY = world.ball.pos.y;
  const relBall = Math.hypot(world.ball.vel.x - p.vel.x, world.ball.vel.z - p.vel.z);
  const speed = Math.hypot(p.vel.x, p.vel.z);
  const heading = { x: Math.sin(p.heading), z: Math.cos(p.heading) };
  const across = speed > 0.5 ? (p.vel.x * heading.x + p.vel.z * heading.z) / speed : 1;
  if (p.balance < 0.5 || nearestOpponentDistance(world, p) < 1.1) return { kind: 'contact', ballY };
  if (ballY > 0.35) return { kind: 'volley', ballY };
  if (relBall > 5) return { kind: 'first-time', ballY };
  if (across < 0.55 || speed > BASE_SPEED * SPRINT_MULTIPLIER * 0.88) {
    return { kind: 'off-balance', ballY };
  }
  return { kind: 'settled', ballY };
}

/** Direction the human is aiming: his stick, or where he is facing if it is centred. */
function aimOf(player: SimPlayer, input: InputFrame, cameraYaw: number): Vec2 {
  const moveDir = cameraRelative(input.move, cameraYaw);
  const facing = { x: Math.sin(player.heading), z: Math.cos(player.heading) };
  return Math.hypot(moveDir.x, moveDir.z) > 0.2 ? moveDir : facing;
}

/** The human asking for a header: shoot aims at goal, pass/cross directs the clearance. */
function headerIntent(world: SimWorld, input: InputFrame, cameraYaw: number): HeaderIntent | null {
  const active = world.players.find((p) => p.id === world.activeId);
  if (!active || active.sentOff) return null;
  const a = input.actions;
  const wants = a.shoot.pressed || a.pass.pressed || a.cross.pressed || a.through.pressed;
  if (!wants) return null;
  if (dist(active.pos, ballPos2(world)) > 2) return null;
  /*
   * Grade the press against the ball's arrival. Perfect is meeting it: roughly 1.3m away at
   * head height and closing. Early or late presses still jump, but the contact is a glance —
   * this is what makes attacking a cross a timing skill rather than a button.
   */
  const gap = dist(active.pos, ballPos2(world));
  const tdist = 1 - clamp(Math.abs(gap - 1.3) / 1.0, 0, 1);
  const ty = 1 - clamp(Math.abs(world.ball.pos.y - 1.9) / 0.9, 0, 1);
  const timing = clamp(0.15 + 0.85 * tdist * ty, 0, 1);
  return {
    playerId: active.id,
    dir: aimOf(active, input, cameraYaw),
    attacking: a.shoot.pressed,
    timing,
  };
}

/** Set pieces: the taker holds the ball until he plays it, and the phase ends on contact. */
function updateRestart(
  world: SimWorld,
  input: InputFrame,
  cameraYaw: number,
  dt: number,
  manager: InputManager,
): void {
  const set = world.restart;
  if (!set) {
    world.phase = 'in-play';
    world.banner = '';
    return;
  }
  set.prepare -= dt;
  set.autoTake -= dt;
  freezeBall(world);

  const taker = findTaker(world, set);
  if (!taker) {
    resumePlay(world);
    return;
  }
  if (!canTake(set)) return;

  world.controllerId = taker.id;
  world.possession = set.side;
  const humanTaker = taker.side === world.config.humanSide && taker.id === world.activeId;

  if (humanTaker) {
    const a = input.actions;
    if (set.kind === 'penalty') {
      if (a.shoot.fired) takePenalty(world, taker, aimOf(taker, input, cameraYaw), a.shoot.charge);
    } else if (set.kind === 'throw-in') {
      // A throw-in is taken with the hands: aim with the stick, K to throw, hold for distance.
      if (a.pass.fired) throwIn(world, taker, aimOf(taker, input, cameraYaw), a.pass.charge);
    } else {
      handleHumanActions(world, input, cameraYaw, manager);
    }
    // If the human never takes it, the referee's patience runs out.
    if (set.autoTake < -10) aiTakeSetPiece(world, set, taker);
  } else if (set.autoTake <= 0) {
    aiTakeSetPiece(world, set, taker);
  }

  if (world.pendingKickId !== null) resumePlay(world);
}

function resumePlay(world: SimWorld): void {
  world.phase = 'in-play';
  world.banner = '';
  world.restart = null;
}

/**
 * Face buttons do different jobs with and without the ball, exactly like the pad: shoot/tackle,
 * cross/slide, pass/jockey, through ball/contain. R1 (driven, finesse, threaded) and L1
 * (chipped, lofted, high) modify whichever kick is played, and the skill button plus a
 * direction plays a trick.
 *
 * Which half of the scheme applies is decided by `InputManager.contextForPress()`, not by who
 * happens to hold the ball this instant, so a pass squeezed off as possession is lost still
 * comes out as a pass.
 */
function handleHumanActions(
  world: SimWorld,
  input: InputFrame,
  cameraYaw: number,
  manager: InputManager,
): void {
  const active = world.players.find((p) => p.id === world.activeId);
  if (!active || active.sentOff) return;
  const a = input.actions;
  const aimDir = aimOf(active, input, cameraYaw);
  const hasBall = world.controllerId === active.id;
  /*
   * A modifier counts if it was down this tick *or released* this tick. Releasing the trigger
   * and the modifier together — which is what fingers naturally do — lands both keyups inside
   * one 16ms tick, and reading only .down meant the finesse or chip silently became a plain
   * driven shot. This was chased for a long time as an input-eating bug; it was release order.
   */
  const r1 = a.modR1.down || a.modR1.released;
  const l1 = a.modL1.down || a.modL1.released;
  /*
   * The backswing. Charging a strike draws the leg back in proportion to the hold, so the
   * follow-through clip that fires on release completes a motion instead of starting one.
   * Shots wind up fully; a cross is a swung delivery too; a pass is a short push and gets less.
   */
  if (world.controllerId === active.id) {
    active.windup = Math.max(
      a.shoot.down ? clamp(a.shoot.heldTime / 1.2, 0, 1) : 0,
      a.cross.down ? clamp(a.cross.heldTime / 1.0, 0, 1) * 0.85 : 0,
      a.pass.down ? clamp(a.pass.heldTime / 1.0, 0, 1) * 0.45 : 0,
    );
  }
  const attacking = manager.contextForPress() === 'ATTACK';

  // An uninterruptible animation swallows the press; buffer it and play it when he is free.
  const locked = active.kickCooldown > 0 || active.skillTimer > 0.15 || active.anim === 'dive';
  if (locked) {
    for (const action of CHARGED_ACTIONS) {
      if (a[action].fired) manager.bufferAction(action, a[action].charge);
    }
    return;
  }

  if (!hasBall && !attacking) {
    // Volley: meet a dropping ball on the run without waiting to control it.
    const airborne = world.ball.pos.y > 0.3 && world.ball.pos.y < 1.6;
    if (airborne && a.shoot.pressed && active.kickCooldown <= 0) {
      if (dist(active.pos, ballPos2(world)) < 1.8) {
        volley(world, active, aimDir);
        return;
      }
    }
    // A tap tackles; holding shoot is the automatic close-down handled in updatePlayers.
    if (a.shoot.released && a.shoot.heldTime < 0.25) tackle(world, active, r1 ? 1.35 : 1);
    if (a.cross.pressed) slideTackle(world, active);
    return;
  }
  if (!hasBall) return;

  // Skill moves: flick a direction with the skill button (right stick on a pad).
  if (a.skill.pressed || (input.flick && Math.hypot(input.flick.x, input.flick.z) > 0.6)) {
    const dir =
      input.flick && Math.hypot(input.flick.x, input.flick.z) > 0.6
        ? cameraRelative(input.flick, cameraYaw)
        : aimDir;
    if (performSkill(world, active, skillFromDirection(active, dir), dir)) return;
  }
  // Fake shot: shoot then pass in the same beat.
  if (a.shoot.down && a.pass.pressed) {
    if (performSkill(world, active, 'fake-shot', aimDir)) {
      // The charge is abandoned, not banked: releasing the button must not still shoot.
      manager.cancel('shoot');
      return;
    }
  }

  // Each of the four kicks fires on `fired`, which covers both the release and the automatic
  // release once the hold reaches maximum charge.
  if (a.shoot.fired) return playShot(world, active, aimDir, a.shoot.charge, r1, l1);
  if (a.through.fired) {
    return playThroughBall(world, active, aimDir, a.through.charge, r1, l1 || a.through.doubleTap);
  }
  if (a.cross.fired) return playCross(world, active, a.cross.charge, r1, l1, a.cross.doubleTap);
  if (a.pass.fired) {
    return playGroundPass(world, active, aimDir, a.pass.charge, r1, l1 || a.pass.doubleTap);
  }
}

/**
 * Plays a buffered action as soon as the animation lock clears. The press is honoured in the
 * context it was made in, so a pass buffered while in possession never emerges as a tackle.
 */
function releaseBuffered(
  world: SimWorld,
  input: InputFrame,
  cameraYaw: number,
  manager: InputManager,
): void {
  const pending = manager.buffer;
  if (!pending) return;
  const active = world.players.find((p) => p.id === world.activeId);
  if (!active || active.sentOff) return;
  // Still locked, or no longer able to play it: leave it queued until it goes stale.
  if (active.kickCooldown > 0 || active.skillTimer > 0.15) return;
  if (world.controllerId !== active.id || pending.context !== 'ATTACK') {
    // Possession was lost while it waited: cancel cleanly rather than firing the wrong thing.
    manager.takeBuffered();
    return;
  }
  const taken = manager.takeBuffered();
  if (!taken) return;
  playBuffered(world, active, taken.action, taken.charge, aimOf(active, input, cameraYaw));
}

/** Replays a buffered kick once the player is free to strike the ball again. */
function playBuffered(
  world: SimWorld,
  active: SimPlayer,
  action: ActionName,
  charge: number,
  aimDir: Vec2,
): void {
  switch (action) {
    case 'shoot':
      playShot(world, active, aimDir, charge, false, false);
      break;
    case 'through':
      playThroughBall(world, active, aimDir, charge, false, false);
      break;
    case 'cross':
      playCross(world, active, charge, false, false, false);
      break;
    case 'pass':
      playGroundPass(world, active, aimDir, charge, false, false);
      break;
    default:
      break;
  }
}

/**
 * Shooting picks where the ball should end up and then solves the launch that puts it there
 * under the real flight model, rather than firing a noisy vector and hoping. R1 is a driven
 * strike, L1 a chip, and neither is a finesse shot — that is the plain button.
 */
function playShot(
  world: SimWorld,
  active: SimPlayer,
  aimDir: Vec2,
  charge: number,
  r1: boolean,
  l1: boolean,
): void {
  const goal = goalCenter(world, active.side);
  // The plain button is a normal, full-blooded strike — that is the one that reaches 100 mph
  // off a clean full charge. Finesse and the chip are the *modified* shots, and both trade pace
  // for placement or loft, so hiding the driven shot behind a modifier meant the headline power
  // was unreachable without knowing an obscure key.
  const style: ShotStyle = l1 ? 'chip' : r1 ? 'finesse' : 'driven';
  const pressure = nearestOpponentDistance(world, active);
  // A centred stick means "at goal"; a held direction is a genuine aim.
  const aim = Math.hypot(aimDir.x, aimDir.z) > 0.2 ? aimDir : null;
  const take = classifyShot(world, active);

  const result = strike(world, active, { style, charge, aim, pressure, take }, world.tuning.shot);
  registerShot(world, active, { x: goal.x, z: result.targetZ });
  world.events.push({
    type: 'shot',
    side: active.side,
    intensity: clamp(result.speed / world.tuning.shot.maxSpeed, 0, 1),
  });
}

function playThroughBall(
  world: SimWorld,
  active: SimPlayer,
  aimDir: Vec2,
  charge: number,
  r1: boolean,
  lofted: boolean,
): void {
  const t = world.tuning.pass.through;
  /*
   * Weighted to reach the space, exactly like a ground pass. This used to take its speed straight
   * from the hold, and a through ball is played twenty-odd metres into space — so a light tap
   * stopped almost immediately and the only usable through ball was a full-power one. Charge now
   * says how he strikes it; the distance decides whether it gets there.
   */
  const option =
    bestThroughBall(world, active, aimDir) ?? bestPass(world, active, aimDir, speedFor(1, t));
  // No runner in the cone is not a dropped input: knock it into the space he is pointing at.
  const spot = option
    ? option.spot
    : { x: active.pos.x + aimDir.x * 22, z: active.pos.z + aimDir.z * 22 };
  // A runner arrives onto it at pace, so it wants less on it at the end than a ball to feet.
  const raw = weightedPassSpeed(
    dist(active.pos, spot),
    charge,
    THROUGH_ARRIVAL_SPEED,
    passSloppiness(world, active),
    world.rand,
  );
  if (lofted) {
    /*
     * A dinked ball over the defensive line. This used to be the flat through-ball speed with a
     * fixed 3.4 m/s of lift bolted on, which is not a trajectory — it either skimmed along or
     * ballooned, depending entirely on how hard the flat pass happened to be.
     */
    const air = loftedLaunch(
      dist(active.pos, spot),
      0.58,
      charge,
      passSloppiness(world, active),
      world.rand,
      speedFor(1, world.tuning.pass.lob),
    );
    kickPass(world, active, spot, HUMAN_PROFILE, 1, {
      lift: air.lift,
      speed: air.speed,
      receiverId: option?.target.id,
    });
    return;
  }
  const speed = clamp(raw, speedFor(0, t), speedFor(1, t)) * (r1 ? 1.1 : 1);
  kickPass(world, active, spot, HUMAN_PROFILE, 1, {
    lift: 0,
    speed,
    receiverId: option?.target.id,
  });
}

function playCross(
  world: SimWorld,
  active: SimPlayer,
  charge: number,
  r1: boolean,
  l1: boolean,
  ground: boolean,
): void {
  const t = world.tuning.pass.lob;
  const option = bestCross(world, active);
  // No target: put it into the middle of the six-to-twelve yard zone, which is where a cross
  // belongs even when nobody has gambled on it yet.
  const spot = option
    ? option.spot
    : { x: goalCenter(world, active.side).x - world.attackDir[active.side] * 9, z: 0 };
  const range = dist(active.pos, spot);

  if (ground) {
    // A cutback is a hard ground pass, so it uses the ground-pass weighting.
    const flat = clamp(
      weightedPassSpeed(
        range,
        charge,
        PASS_ARRIVAL_SPEED,
        passSloppiness(world, active),
        world.rand,
      ),
      speedFor(0, world.tuning.pass.ground),
      speedFor(1, world.tuning.pass.ground),
    );
    kickPass(world, active, spot, HUMAN_PROFILE, 1, {
      lift: 0,
      speed: flat,
      receiverId: option?.target.id,
    });
    return;
  }

  /*
   * A cross is a ballistic problem, not a power problem. Taking the speed from hold time and
   * *then* splitting it into a launch angle meant a short hold produced about six metres per
   * second of horizontal pace — the ball travelled eight metres and dropped, nowhere near the
   * box. Solve the launch that actually carries the distance instead, so even a light press
   * reaches the middle, and let charge decide how it is delivered.
   *
   * In a vacuum `v = sqrt(R * g / sin(2 * theta))`; the ball's drag costs a little more than that.
   */
  const theta = r1 ? 0.38 : l1 ? 0.72 : 0.55;
  const needed = Math.sqrt((range * 9.81) / Math.max(0.2, Math.sin(2 * theta))) * 1.12;
  const sloppiness = passSloppiness(world, active);
  const misweight = 1 + (world.rand() + world.rand() - 1) * sloppiness * 0.35;
  const v = clamp(needed * (0.95 + charge * 0.35) * misweight, 6, speedFor(1, t));
  kickPass(world, active, spot, HUMAN_PROFILE, 1, {
    lift: v * Math.sin(theta),
    speed: v * Math.cos(theta),
    receiverId: option?.target.id,
  });
  switchToBox(world, active, spot);
}

/**
 * Hand the player whoever is actually going to attack the cross.
 *
 * Control used to stay with the man who had just crossed it, so you stood on the wing watching
 * the ball drop into the six-yard box with nobody under your command. The receiver is only known
 * once the ball lands, and by then the header has happened — so the switch has to happen at the
 * moment the ball is struck, to whoever is best placed to meet it.
 */
function switchToBox(world: SimWorld, crosser: SimPlayer, spot: Vec2): void {
  if (crosser.side !== world.config.humanSide) return;
  let best: SimPlayer | null = null;
  let bestScore = Infinity;
  for (const p of world.players) {
    if (p.side !== crosser.side || p.id === crosser.id || p.role === 'GK' || p.sentOff) continue;
    // Who can get to where it is going, preferring men already in the danger area.
    const score = dist(p.pos, spot) - (dist(p.pos, goalCenter(world, p.side)) < 20 ? 4 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  /*
   * Queue it rather than switching now. Handing control over the instant the ball leaves the boot
   * gives the player no sight of the flight — he is teleported into the box and the cross is
   * already on him. The switch fires as it drops (see `resolvePendingSwitch`), which is when a
   * real player picks out the man attacking it and times his header.
   */
  if (best && bestScore < 26) world.pendingSwitch = best.id;
}

/** How close the ball must be to the queued receiver before control is handed over. */
const CROSS_HANDOVER_METRES = 16;

/**
 * Hands over control for a queued cross once the ball is nearly on the receiver, so the player
 * sees the ball travel and still has a beat to attack it.
 */
function resolvePendingSwitch(world: SimWorld): void {
  const id = world.pendingSwitch;
  if (id === null) return;
  const man = world.players.find((p) => p.id === id);
  // The move is over: somebody has it, it is dead, or the man is gone.
  if (!man || man.sentOff || world.phase !== 'in-play' || world.controllerId !== null) {
    world.pendingSwitch = null;
    return;
  }
  const gap = dist(man.pos, ballPos2(world));
  // Past the steep part of the climb: waiting for it to actually fall handed over with only a
  // few tenths left, which is not enough time for a human to attack the ball.
  const dropping = world.ball.vel.y < 3.5;
  if (gap < CROSS_HANDOVER_METRES && dropping) {
    world.activeId = man.id;
    // Count it as the player's own choice so the auto-switcher does not immediately undo it.
    world.switching.sinceManual = 0;
    world.pendingSwitch = null;
  }
}

function playGroundPass(
  world: SimWorld,
  active: SimPlayer,
  aimDir: Vec2,
  charge: number,
  r1: boolean,
  lofted: boolean,
): void {
  const t = lofted ? world.tuning.pass.lob : world.tuning.pass.ground;
  /*
   * Pick the receiver first, at the pace the passer *could* manage, then weight the pass to
   * actually reach him.
   *
   * Charge used to set the raw launch speed and the receiver was whoever that speed happened to
   * reach — so a light press to a man fifteen metres away simply died halfway, and the only way
   * to find a team-mate was to hold the button. That is backwards: a footballer decides who he
   * is passing to and then hits it hard enough. Charge should say *how* he hits it, not whether
   * it gets there.
   */
  const option = bestPass(world, active, aimDir, speedFor(1, t));
  if (!option) {
    // Nobody in the cone: strike it into space rather than swallowing the press.
    const loose = speedFor(charge, t) * (r1 ? 1.1 : 1);
    applyKick(world, active, aimDir, loose, lofted ? 3 : 0, 0, 'pass');
    world.events.push({ type: 'kick', side: active.side, intensity: charge });
    return;
  }
  // A rolling ball sheds pace roughly linearly with distance, so the speed needed to arrive with
  // something on it is close to `arrival + k * distance`.
  const range = dist(active.pos, option.spot);
  // A tap is a properly weighted ball to feet; leaning on it drives the same pass through him,
  // which is what you want when you are trying to beat a man to it.
  /*
   * Weight error. Solving the pass to arrive exactly removed the *overhit* failure mode, and with
   * it every failure mode — completion went to 100%, which is not football. A passer under
   * pressure, or simply not a good one, mis-weights it: short into a defender's path, or heavy
   * through his man. Scaled by the passing attribute and by how tight he is being closed down.
   */
  const raw = weightedPassSpeed(
    range,
    charge,
    PASS_ARRIVAL_SPEED,
    passSloppiness(world, active),
    world.rand,
  );
  const speed = clamp(raw, speedFor(0, t), speedFor(1, t)) * (r1 ? 1.1 : 1);
  if (lofted) {
    // Chipped over the press and dropped on him, rather than a ground pass with some loft added.
    const air = loftedLaunch(
      range,
      0.62,
      charge,
      passSloppiness(world, active),
      world.rand,
      speedFor(1, world.tuning.pass.lob),
    );
    kickPass(world, active, option.spot, HUMAN_PROFILE, 1, {
      lift: air.lift,
      speed: air.speed,
      receiverId: option.target.id,
    });
    return;
  }
  kickPass(world, active, option.spot, HUMAN_PROFILE, 1, {
    lift: 0,
    speed,
    receiverId: option.target.id,
  });
}

/** First-time strike at a ball that is still in the air: powerful, but hard to keep down. */
function volley(world: SimWorld, player: SimPlayer, aimDir: Vec2): void {
  const goal = goalCenter(world, player.side);
  const d = dist(player.pos, goal);
  const toGoal = normalize(sub(goal, player.pos));
  const dir = d < 32 ? toGoal : aimDir;
  const spread = (1 - player.shooting / 130) * 0.22;
  const aimed = normalize({
    x: dir.x + (world.rand() * 2 - 1) * spread,
    z: dir.z + (world.rand() * 2 - 1) * spread,
  });
  const power = 16 + (player.shooting / 100) * 10;
  applyKick(world, player, aimed, power, clamp(1.4 - world.ball.pos.y, 0.1, 1.2), 0, 'shot');
  registerShot(world, player, { x: goal.x, z: player.pos.z + aimed.z * 4 });
  world.events.push({ type: 'shot', side: player.side, intensity: 0.9 });
}

/**
 * Standing tackle. `commitment` above 1 is the held "hard" tackle: better odds, but the tackler
 * is out of the play for longer when it fails — and more likely to give away a free kick.
 */
function tackle(
  world: SimWorld,
  tackler: SimPlayer,
  commitment = 1,
  reach = 2.4,
  sliding = false,
): void {
  const target = world.players.find((p) => p.id === world.controllerId);
  tackler.kickCooldown = Math.max(tackler.kickCooldown, 0.25 * commitment);
  tackler.anim = sliding ? 'slide' : 'tackle';
  tackler.animTimer = sliding ? 0.8 : 0.3;
  if (sliding) {
    /*
     * A slide is a commitment: you end up on the grass and you have to get up. Previously it cost
     * a brief animation and nothing else, so sliding was close to free and could be spammed.
     */
    tackler.kickCooldown = Math.max(tackler.kickCooldown, 1.05);
    tackler.skillTimer = Math.max(tackler.skillTimer, 0.85);
  }
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
    // A missed hard challenge leaves the defender on the floor — and often in the book.
    tackler.kickCooldown = Math.max(tackler.kickCooldown, 0.25 * commitment * 2);
    const contact = d < reach * 0.75;
    const foulChance = sliding ? 0.55 : 0.25 * commitment;
    if (contact && world.rand() < foulChance) {
      awardFoul(world, tackler, target, {
        severity: sliding ? 0.55 + world.rand() * 0.45 : 0.2 + world.rand() * 0.4,
      });
    }
    return;
  }
  const dir = normalize(sub(goalCenter(world, tackler.side), tackler.pos));
  tackler.tally.tackles += 1;
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
  tackle(world, tackler, 1.2, 3.4, true);
  tackler.kickCooldown = Math.max(tackler.kickCooldown, 0.85);
}
