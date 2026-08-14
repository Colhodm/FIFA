export interface Vec2 {
  x: number;
  z: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v2 = (x = 0, z = 0): Vec2 => ({ x, z });

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, z: a.z + b.z });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, z: a.z - b.z });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, z: a.z * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.z * b.z;
export const len = (a: Vec2): number => Math.hypot(a.x, a.z);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);
export const dist2 = (a: Vec2, b: Vec2): number => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;

export function normalize(a: Vec2): Vec2 {
  const l = len(a);
  return l < 1e-6 ? { x: 0, z: 0 } : { x: a.x / l, z: a.z / l };
}

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Frame-rate independent exponential smoothing factor. */
export const smoothing = (dt: number, tau: number): number => 1 - Math.exp(-dt / tau);

export function angleTo(from: Vec2, to: Vec2): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

/**
 * Rotates camera-relative input (x = screen right, z = screen up) into pitch space.
 *
 * The camera looks along `forward = (sin yaw, cos yaw)`. Screen right is `cross(forward, up)`
 * with up = +y, which is `(-cos yaw, sin yaw)` — *not* `(cos yaw, -sin yaw)`. Getting that
 * sign wrong mirrors every horizontal input: pressing right walks the player left.
 */
export function cameraRelative(move: Vec2, cameraYaw: number): Vec2 {
  const sin = Math.sin(cameraYaw);
  const cos = Math.cos(cameraYaw);
  return {
    x: move.z * sin - move.x * cos,
    z: move.z * cos + move.x * sin,
  };
}

/** Shortest signed delta between two angles, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Distance from point p to the segment ab. Used for passing-lane and marking checks. */
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-6) return dist(p, a);
  const t = clamp(dot(sub(p, a), ab) / l2, 0, 1);
  return dist(p, { x: a.x + ab.x * t, z: a.z + ab.z * t });
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
