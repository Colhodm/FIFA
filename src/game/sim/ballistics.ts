import { BALL_RADIUS, MAGNUS } from '../constants';
import type { Vec3 } from './math';

/**
 * A forward model of the ball in flight that matches what the renderer's rigid body actually
 * does, so a trajectory solved here lands where it was solved to land.
 *
 * The live ball is a Rapier body with `linearDamping` and gravity, plus the Magnus acceleration
 * the frame loop applies from the sidespin. Those three are reproduced exactly:
 *
 * - gravity      `a.y -= g`
 * - drag         Rapier's damping form, `v /= 1 + damping * dt`
 * - Magnus       `a += MAGNUS * spinY * (v.z, 0, -v.x)`, i.e. sidespin curls the ball
 *
 * Nothing here is a separate "physics engine": it is a cheap replica used only to aim.
 */
export interface FlightModel {
  gravity: number;
  /** Rapier `linearDamping` on the ball body. */
  damping: number;
  /** Fraction of the spin remaining after one second. */
  spinDecay: number;
}

export const DEFAULT_FLIGHT: FlightModel = { gravity: 9.81, damping: 0.32, spinDecay: 0.55 };

/** One instant of a predicted flight. */
export interface FlightSample {
  t: number;
  x: number;
  y: number;
  z: number;
}

/** Mutable state advanced by `flightStep`. */
export interface FlightState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  spin: number;
}

/**
 * Advances the ball one step under the exact forces the live body feels: gravity, Rapier's
 * damping form, the Magnus term, and the ground bounce. This is *the* forward model — the shot
 * solver, the trajectory cache and (through it) the goalkeeper all use this one function, so
 * prediction and reality can no longer quietly disagree. The knuckle force is deliberately
 * absent: it is noise, and nobody should be able to predict it — that is what makes it knuckle.
 */
export function flightStep(
  st: FlightState,
  dt: number,
  model: FlightModel = DEFAULT_FLIGHT,
): boolean {
  const ax = MAGNUS * st.spin * st.vz;
  const az = -MAGNUS * st.spin * st.vx;
  st.vx += ax * dt;
  st.vz += az * dt;
  st.vy -= model.gravity * dt;
  const damp = 1 / (1 + model.damping * dt);
  st.vx *= damp;
  st.vy *= damp;
  st.vz *= damp;
  st.x += st.vx * dt;
  st.y += st.vy * dt;
  st.z += st.vz * dt;
  st.spin *= Math.pow(model.spinDecay, dt);
  if (st.y < BALL_RADIUS && st.vy < 0) {
    st.y = BALL_RADIUS;
    st.vy = -st.vy * 0.62;
    if (Math.abs(st.vy) < 0.6) st.vy = 0;
    // Grass takes pace off a bouncing ball beyond the air damping.
    st.vx *= 0.85;
    st.vz *= 0.85;
    return true;
  }
  return false;
}

/**
 * Rolls the whole flight forward and samples it. Rebuilt whenever the ball is struck or
 * deflected; queried instead of every consumer doing its own physics.
 */
export function predictFlight(
  from: { x: number; y: number; z: number },
  vel: { x: number; y: number; z: number },
  spinY: number,
  seconds = 2.5,
  hz = 30,
  model: FlightModel = DEFAULT_FLIGHT,
): FlightSample[] {
  const st: FlightState = {
    x: from.x,
    y: from.y,
    z: from.z,
    vx: vel.x,
    vy: vel.y,
    vz: vel.z,
    spin: spinY,
  };
  const dt = 1 / 120;
  const out: FlightSample[] = [{ t: 0, x: st.x, y: st.y, z: st.z }];
  const every = Math.max(1, Math.round(120 / hz));
  let i = 0;
  for (let t = 0; t < seconds; t += dt) {
    flightStep(st, dt, model);
    i++;
    if (i % every === 0) out.push({ t: t + dt, x: st.x, y: st.y, z: st.z });
    if (Math.hypot(st.vx, st.vz) < 0.4 && st.y <= BALL_RADIUS + 0.01) break;
  }
  return out;
}

export interface Crossing {
  /** Where the ball crosses the plane. */
  z: number;
  y: number;
  /** Seconds taken to get there. */
  t: number;
}

/**
 * Flies the ball from `from` at `vel` and reports where it crosses `planeX`, or null if it never
 * does. `spinY` is sidespin in rad/s, matching `world.ball.spin.y`.
 */
export function crossingAt(
  from: Vec3,
  vel: Vec3,
  spinY: number,
  planeX: number,
  model: FlightModel = DEFAULT_FLIGHT,
  dt = 1 / 120,
  maxTime = 4,
): Crossing | null {
  const st: FlightState = {
    x: from.x,
    y: from.y,
    z: from.z,
    vx: vel.x,
    vy: vel.y,
    vz: vel.z,
    spin: spinY,
  };
  const towards = Math.sign(planeX - st.x);
  if (towards === 0) return { z: st.z, y: st.y, t: 0 };

  for (let t = 0; t < maxTime; t += dt) {
    const px = st.x;
    const py = st.y;
    const pz = st.z;
    // If it hits the deck before the plane the shot is simply short. Bouncing on and reporting
    // a crossing several hops later makes this function wildly non-smooth, and the solver's
    // numerical Jacobian then points in nonsense directions.
    if (flightStep(st, dt, model)) return null;
    if (Math.sign(planeX - st.x) !== towards) {
      const span = st.x - px;
      const f = Math.abs(span) < 1e-9 ? 0 : (planeX - px) / span;
      return { z: pz + (st.z - pz) * f, y: py + (st.y - py) * f, t: t + dt * f };
    }
  }
  return null;
}

export interface LaunchSolution {
  vel: Vec3;
  crossing: Crossing;
  /** How far the solved trajectory misses the requested target, in metres. */
  error: number;
}

/**
 * Solves *backwards*: given where the ball starts, how hard it is being hit and what spin is on
 * it, find the launch vector that puts it through `(targetZ, targetY)` on the plane `planeX`.
 *
 * Drag and Magnus make this non-closed-form, so it is a shooting method — fly the ball, measure
 * the miss at the goal plane, nudge azimuth and elevation, repeat. It converges in a handful of
 * iterations and costs microseconds.
 *
 * Solving backwards is what stops shots missing in unsatisfying ways: the error model decides
 * where the ball should end up, and the physics is then made to agree, rather than errors being
 * injected into the launch and the outcome left to chance.
 */
export function solveLaunch(
  from: Vec3,
  targetZ: number,
  targetY: number,
  planeX: number,
  speed: number,
  spinY: number,
  model: FlightModel = DEFAULT_FLIGHT,
  iterations = 12,
  /**
   * Take the *high* root instead. A chip is defined by clearing the keeper, so forcing it onto
   * the low arc — which is right for every other shot — turned it into a flat drive at waist
   * height and the mechanic did nothing.
   */
  preferHigh = false,
): LaunchSolution | null {
  const dx = planeX - from.x;
  const dz = targetZ - from.z;
  const flat = Math.hypot(dx, dz);
  // Start from the straight line to the target, lofted enough to cover the drop.
  const bearing = Math.atan2(dz, dx);
  let azimuth = bearing;

  /*
   * Every ballistic problem has two answers: drive it flat, or lob it. Seeding the search with a
   * rough guess and letting Newton wander finds the *high* one about as often as the low one,
   * which turns a twelve-yard shot into a floated lob straight into the keeper's hands.
   *
   * So: start from the closed-form low-arc solution in a vacuum, and never let the search climb
   * far above it. Drag means the real answer sits a little higher than the vacuum one — hence
   * the margin — but it is always the low root.
   */
  const g = model.gravity;
  const dy = targetY - from.y;
  const v2 = speed * speed;
  const disc = v2 * v2 - g * (g * flat * flat + 2 * dy * v2);
  const lowArc = disc >= 0 ? Math.atan((v2 - Math.sqrt(disc)) / (g * flat)) : Math.PI / 4;
  const highArc = disc >= 0 ? Math.atan((v2 + Math.sqrt(disc)) / (g * flat)) : Math.PI / 3;
  let elevation = preferHigh ? highArc : lowArc;
  const maxElevation = preferHigh ? Math.min(1.45, highArc + 0.3) : Math.min(1.1, lowArc + 0.4);
  const minElevation = preferHigh ? Math.max(0.35, highArc - 0.45) : -0.2;
  // A strike is never launched wildly off the line to its target — the curl needs a few degrees,
  // not forty. Without this the solver can walk the azimuth away and fire square across goal.
  const MAX_OFF_BEARING = 0.42;

  const launchFrom = (az: number, el: number): Vec3 => {
    const horizontal = Math.cos(el) * speed;
    return { x: Math.cos(az) * horizontal, y: Math.sin(el) * speed, z: Math.sin(az) * horizontal };
  };

  let best: LaunchSolution | null = null;
  const H = 0.004;

  for (let i = 0; i < iterations; i++) {
    const base = crossingAt(from, launchFrom(azimuth, elevation), spinY, planeX, model);
    if (!base) {
      // Dropped short of the plane: lift it, but stay under the low-arc ceiling.
      elevation = Math.min(maxElevation, elevation + 0.06);
      continue;
    }
    const errZ = base.z - targetZ;
    const errY = base.y - targetY;
    const error = Math.hypot(errZ, errY);
    if (!best || error < best.error) {
      best = { vel: launchFrom(azimuth, elevation), crossing: base, error };
    }
    if (error < 0.05) break;

    // Numerical Jacobian: how the crossing moves with each control.
    const dAz = crossingAt(from, launchFrom(azimuth + H, elevation), spinY, planeX, model);
    const dEl = crossingAt(from, launchFrom(azimuth, elevation + H), spinY, planeX, model);
    if (!dAz || !dEl) break;

    const j11 = (dAz.z - base.z) / H;
    const j12 = (dEl.z - base.z) / H;
    const j21 = (dAz.y - base.y) / H;
    const j22 = (dEl.y - base.y) / H;
    const det = j11 * j22 - j12 * j21;
    if (Math.abs(det) < 1e-6) break;

    // Newton step, damped so a poor Jacobian cannot throw the solution away, and kept inside a
    // cone around the direct bearing.
    const stepAz = (errZ * j22 - errY * j12) / det;
    const stepEl = (errY * j11 - errZ * j21) / det;
    azimuth -= Math.max(-0.12, Math.min(0.12, stepAz));
    elevation -= Math.max(-0.12, Math.min(0.12, stepEl));
    azimuth = Math.max(bearing - MAX_OFF_BEARING, Math.min(bearing + MAX_OFF_BEARING, azimuth));
    elevation = Math.max(minElevation, Math.min(maxElevation, elevation));
  }

  // A solution that still misses by more than a goal's width is not a solution. Say so, and let
  // the caller strike it plainly rather than firing off a nonsense vector.
  return best && best.error < 2.5 ? best : null;
}
