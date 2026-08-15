import { CONTROL_RADIUS, HALF_GOAL_WIDTH, HEADER_HEIGHT, JUMP_HEIGHT } from '../constants';
import { registerShot } from './ai';
import { applyKick, ballPos2, goalCenter, ownGoalCenter } from './kick';
import { clamp, dist, distToSegment, normalize, sub, type Vec2 } from './math';
import { onPitch, type SimPlayer, type SimWorld } from './state';

const GRAVITY = 9.81;
/** Take-off speed that reaches JUMP_HEIGHT. */
const JUMP_VELOCITY = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT);
/** Horizontal distance a player can head or a keeper can dive to. */
const HEADER_REACH = 1.5;
const DIVE_REACH = 2.4;

/** Ball height at which the players are heading it rather than kicking it. */
export const isAerial = (world: SimWorld): boolean =>
  world.ball.pos.y > 1.05 && world.ball.pos.y < HEADER_HEIGHT;

/** Gravity for jumping players, plus the countdown on animation and dive states. */
export function updateBodies(world: SimWorld, dt: number): void {
  // Wind-up is re-asserted each tick by whoever is charging; everyone else stands unwound.
  for (const p of world.players) p.windup = 0;
  for (const p of world.players) {
    if (p.height > 0 || p.verticalVel !== 0) {
      p.verticalVel -= GRAVITY * dt;
      p.height += p.verticalVel * dt;
      if (p.height <= 0) {
        p.height = 0;
        p.verticalVel = 0;
      }
    }
    p.skillTimer = Math.max(0, p.skillTimer - dt);
    p.holdTimer = Math.max(0, p.holdTimer - dt);
    if (p.animTimer > 0) {
      p.animTimer -= dt;
      if (p.animTimer <= 0) {
        p.animTimer = 0;
        p.anim = 'run';
        p.diveDir = 0;
      }
    }
  }
}

export function startJump(p: SimPlayer): void {
  if (p.height > 0.02) return;
  p.verticalVel = JUMP_VELOCITY;
  p.anim = 'jump';
  p.animTimer = Math.max(p.animTimer, 0.7);
}

export interface HeaderIntent {
  playerId: number;
  dir: Vec2;
  /** True when the human asked for a header at goal rather than a clearance. */
  attacking: boolean;
}

/**
 * Contests a ball in the air. The best jumper — height, strength and a slice of luck — wins
 * the duel and heads it; everyone else in the cluster is left on the ground.
 * `intent` lets the human direct his own header instead of taking the automatic one.
 */
export function resolveAerials(world: SimWorld, intent: HeaderIntent | null): boolean {
  if (!isAerial(world)) return false;
  const ball = ballPos2(world);
  const speed = Math.hypot(world.ball.vel.x, world.ball.vel.z);

  let winner: SimPlayer | null = null;
  let bestScore = 0;
  const contenders: SimPlayer[] = [];
  for (const p of onPitch(world)) {
    if (p.kickCooldown > 0 || p.role === 'GK') continue;
    if (dist(p.pos, ball) > HEADER_REACH) continue;
    contenders.push(p);
    // Leap, strength and timing decide who gets his head on it.
    const score =
      p.physical * 0.6 +
      p.defending * 0.2 +
      p.shooting * 0.1 +
      world.rand() * 30 +
      (intent && intent.playerId === p.id ? 25 : 0);
    if (score > bestScore) {
      bestScore = score;
      winner = p;
    }
  }
  if (!winner) return false;

  for (const p of contenders) {
    startJump(p);
    if (p.id !== winner.id) p.kickCooldown = Math.max(p.kickCooldown, 0.45);
  }

  const goal = goalCenter(world, winner.side);
  const own = ownGoalCenter(world, winner.side);
  const toGoal = dist(winner.pos, goal);
  const onTheAttack = intent ? intent.attacking : toGoal < 20;
  const power = 8 + (winner.physical / 100) * 6 + (onTheAttack ? winner.shooting / 25 : 0);

  if (onTheAttack) {
    const aim = {
      x: goal.x,
      z: clamp(
        (world.rand() * 2 - 1) * (HALF_GOAL_WIDTH - 0.4) * (0.4 + winner.shooting / 200),
        -HALF_GOAL_WIDTH + 0.3,
        HALF_GOAL_WIDTH - 0.3,
      ),
    };
    const dir =
      intent && Math.hypot(intent.dir.x, intent.dir.z) > 0.3 ? intent.dir : sub(aim, winner.pos);
    applyKick(world, winner, normalize(dir), power + speed * 0.15, -0.6);
    registerShot(world, winner, aim);
    world.events.push({ type: 'header', side: winner.side, intensity: 0.8 });
    return true;
  }

  // Defensive header: away from the danger zone, out towards the nearest touchline.
  const awayFromGoal = normalize(sub(winner.pos, own));
  const outwards = Math.sign(winner.pos.z || 1);
  const clear =
    intent && Math.hypot(intent.dir.x, intent.dir.z) > 0.3
      ? intent.dir
      : { x: awayFromGoal.x * 1.4, z: outwards * 0.9 };
  applyKick(world, winner, normalize(clear), power + 4, 4.5);
  world.events.push({ type: 'header', side: winner.side, intensity: 0.6 });
  return true;
}

/**
 * Keepers: read the shot, commit to a dive, and either hold it or push it away. A held ball
 * buys a couple of seconds before distribution; a parry drops back into play.
 */
/** Where and when the cached flight crosses the vertical plane x = lineX, if it does. */
function crossingOnLine(
  world: SimWorld,
  lineX: number,
): { z: number; y: number; t: number } | null {
  const flight = world.flight;
  if (!flight || flight.length < 2) return null;
  for (let i = 1; i < flight.length; i++) {
    const a = flight[i - 1];
    const b = flight[i];
    if (Math.sign(lineX - a.x) !== Math.sign(lineX - b.x)) {
      const span = b.x - a.x;
      const f = Math.abs(span) < 1e-9 ? 0 : (lineX - a.x) / span;
      return { z: a.z + (b.z - a.z) * f, y: a.y + (b.y - a.y) * f, t: a.t + (b.t - a.t) * f };
    }
  }
  return null;
}

export function updateKeepers(world: SimWorld, dt: number): void {
  const ball = ballPos2(world);
  const speed = Math.hypot(world.ball.vel.x, world.ball.vel.z);

  for (const keeper of onPitch(world)) {
    if (keeper.role !== 'GK') continue;
    const own = ownGoalCenter(world, keeper.side);
    const towardsGoal = (own.x - world.ball.pos.x) * world.ball.vel.x > 0;
    const closing = Math.abs(world.ball.vel.x);

    // Commit to a dive when a struck ball is about to arrive within reach of a full stretch.
    if (
      keeper.diveDir === 0 &&
      keeper.kickCooldown <= 0 &&
      towardsGoal &&
      speed > 9 &&
      closing > 4
    ) {
      /*
       * Read the real flight, not a straight line. The keeper used to extrapolate linearly with
       * a bare gravity term — a third model of the same ball, disagreeing with both the rigid
       * body and the shot solver, so he dived to where a different physics engine thought the
       * ball was going. Curl beat him for free; now it has to actually beat him.
       */
      const read = crossingOnLine(world, own.x);
      const eta = read ? read.t : Math.abs(own.x - world.ball.pos.x) / closing;
      const crossZ = read ? read.z : world.ball.pos.z + world.ball.vel.z * eta;
      const crossY = read
        ? read.y
        : world.ball.pos.y + world.ball.vel.y * eta - 0.5 * GRAVITY * eta * eta;
      const lateral = crossZ - keeper.pos.z;
      const reachable = Math.abs(lateral) < DIVE_REACH + keeper.defending / 60;
      // A keeper reads the shot, he does not know where it is going. Diving to the exact
      // crossing point made him unbeatable: with a 7.3 m goal and a full-stretch reach he
      // covered every corner, and 40 clear shots produced no goals at all. The error grows with
      // the pace on the ball and shrinks with his rating.
      const misread =
        (world.rand() * 2 - 1) * clamp((speed / 9) * (1.6 - keeper.defending / 100), 0.3, 3.2);
      // Nobody reacts to a shot struck from six yards; he has to have started already.
      if (eta < 0.18) continue;
      if (eta < 0.55 && reachable && crossY < 2.6 && Math.abs(crossZ) < HALF_GOAL_WIDTH + 1.2) {
        keeper.diveDir = Math.sign(lateral) || (world.rand() < 0.5 ? -1 : 1);
        keeper.diveTargetZ = crossZ + misread;
        keeper.anim = 'dive';
        keeper.animTimer = 0.9;
        keeper.verticalVel = JUMP_VELOCITY * (crossY > 1.2 ? 0.9 : 0.45);
      }
    }

    if (keeper.anim === 'dive') {
      // Stretch across goal towards where the ball is actually going, and stop there.
      const stretch = 3.4 + keeper.defending / 55;
      const remaining = keeper.diveTargetZ - keeper.pos.z;
      const move = clamp(remaining, -stretch * dt, stretch * dt);
      keeper.vel = { x: keeper.vel.x * 0.5, z: move / dt };
      keeper.pos.z += move;
    }

    // Full stretch is an arm's length beyond where he actually got to, not a third of the goal.
    const reach = CONTROL_RADIUS + 0.55 + (keeper.anim === 'dive' ? 0.15 : 0);
    // A struck ball can cross the whole reach inside one tick, so test the path it swept.
    const swept = { x: ball.x + world.ball.vel.x * dt, z: ball.z + world.ball.vel.z * dt };
    const d = Math.min(dist(keeper.pos, ball), distToSegment(keeper.pos, ball, swept));
    if (keeper.kickCooldown > 0 || d > reach || world.ball.pos.y > 2.7) continue;
    if (speed < 9) continue;

    // Hard, high shots get pushed away; anything he can get two hands to is claimed. He can
    // only *claim* a ball already at his body — reaching out and having it snap into his gloves
    // from two metres away is the teleport that reads so badly.
    const atHands = dist(keeper.pos, ball) < CONTROL_RADIUS + 0.15;
    const control = atHands ? clamp(0.95 - speed / 45 + keeper.defending / 260, 0.1, 0.95) : 0;
    world.stats[keeper.side].saves += 1;
    keeper.tally.saves += 1;
    world.events.push({ type: 'save', side: keeper.side, intensity: clamp(speed / 26, 0.2, 1) });
    if (world.rand() < control) {
      // Smothered: the ball stops where it is, at his body. No jump across the six-yard box.
      world.ball.vel = { x: 0, y: 0, z: 0 };
      world.ball.spin = { x: 0, y: 0, z: 0 };
      world.commands.push({ type: 'velocity', vel: { x: 0, y: 0, z: 0 } });
      world.controllerId = keeper.id;
      world.possession = keeper.side;
      world.lastTouch = { side: keeper.side, playerId: keeper.id };
      // He gets up, looks for the counter, then distributes.
      keeper.holdTimer = 1.6 + world.rand() * 0.9;
    } else {
      // Reflect off the hands about the contact normal, the way any other deflection resolves.
      // The keeper steers it a little — strong hands push it wide rather than back into play —
      // but the pace and line come from the ball that arrived, not from a fixed vector.
      const n = normalize(sub(ball, keeper.pos));
      const nx = n.x || Math.sign(ball.x - keeper.pos.x) || 1;
      const nz = n.z;
      const v = world.ball.vel;
      const along = v.x * nx + v.z * nz;
      const HANDS = 0.55;
      // Velocity reflected about the normal, damped by the hands absorbing the strike.
      let rx = (v.x - 2 * along * nx) * HANDS;
      let rz = (v.z - 2 * along * nz) * HANDS;
      // A good keeper pushes it away from the danger area rather than straight back out.
      const steer = 0.35 + keeper.defending / 200;
      const outwards = Math.sign(ball.z - keeper.pos.z || 1);
      rx += nx * speed * 0.12;
      rz += outwards * speed * 0.12 * steer;
      const vel = { x: rx, y: Math.max(1.2, Math.abs(v.y) * 0.5 + speed * 0.06), z: rz };
      world.ball.vel = vel;
      world.ball.spin = { x: 0, y: 0, z: 0 };
      world.commands.push({ type: 'velocity', vel });
      world.lastTouch = { side: keeper.side, playerId: keeper.id };
      // A parry is a loose ball in the most dangerous place on the pitch. See the block path.
      world.possession = null;
      world.flightDirty = true;
      keeper.kickCooldown = 0.5;
      world.controllerId = null;
    }
  }
}
