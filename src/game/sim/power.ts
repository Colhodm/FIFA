import type { PowerTuning } from '../tuning';
import { clamp } from './math';

/**
 * Hold-to-power curve. A slight ease-in (exponent 1.1) keeps short taps gentle without making
 * the middle of the range feel dead.
 */
export const chargeCurve = (charge: number): number => Math.pow(clamp(charge, 0, 1), 1.1);

/**
 * Ball speed for a normalised 0..1 charge:
 * `p_min + (p_max - p_min) * (t_hold / t_max)^1.1`, with `p_min` a fraction of `p_max` so a tap
 * still produces a usable short pass instead of dribbling the ball two metres.
 */
export function speedFor(charge: number, tuning: PowerTuning): number {
  const min = tuning.maxSpeed * tuning.minPowerFraction;
  return min + (tuning.maxSpeed - min) * chargeCurve(charge);
}

/** Launch angle of a lofted pass, in radians, rising with power. */
export function lobAngle(charge: number, range: [number, number]): number {
  const [low, high] = range;
  return ((low + (high - low) * chargeCurve(charge)) * Math.PI) / 180;
}

/**
 * Vertical component for a lofted ball struck at `speed` and `angle`. The sim treats `lift` as a
 * straight upward velocity, so the horizontal speed is the adjacent side of the same triangle.
 */
export function liftFor(speed: number, angle: number): number {
  return speed * Math.sin(angle);
}

/** Horizontal component matching `liftFor`, so total launch speed stays honest. */
export function groundSpeedFor(speed: number, angle: number): number {
  return speed * Math.cos(angle);
}
