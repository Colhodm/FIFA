export type QualityMode = 'auto' | 'low' | 'medium' | 'high' | 'ultra';

export interface QualityTier {
  id: number;
  name: string;
  /** Renderer pixel ratio cap — stepped down first because it is the cheapest win. */
  dpr: number;
  shadows: boolean;
  shadowMapSize: number;
  /** 0..1 multiplier on stadium crowd instances. */
  crowdDensity: number;
  /** Runs the bloom/AA/vignette composer instead of rendering straight to the screen. */
  postFx: boolean;
  /** Screen-space ambient occlusion inside the composer; the most expensive effect here. */
  ambientOcclusion: boolean;
  /** Cube resolution of the generated environment map that lights the kits and the ball. */
  envResolution: number;
}

export const TIERS: QualityTier[] = [
  {
    id: 0,
    name: 'Low',
    dpr: 0.75,
    shadows: false,
    shadowMapSize: 512,
    crowdDensity: 0.15,
    postFx: false,
    ambientOcclusion: false,
    envResolution: 32,
  },
  {
    id: 1,
    name: 'Medium',
    dpr: 1,
    shadows: true,
    shadowMapSize: 1024,
    crowdDensity: 0.4,
    postFx: false,
    ambientOcclusion: false,
    envResolution: 64,
  },
  {
    id: 2,
    name: 'High',
    dpr: 1.5,
    shadows: true,
    shadowMapSize: 2048,
    crowdDensity: 0.7,
    postFx: true,
    ambientOcclusion: false,
    envResolution: 128,
  },
  {
    id: 3,
    name: 'Ultra',
    dpr: 2,
    shadows: true,
    shadowMapSize: 4096,
    crowdDensity: 1,
    postFx: true,
    ambientOcclusion: true,
    envResolution: 256,
  },
];

export const MANUAL_TIER: Record<Exclude<QualityMode, 'auto'>, number> = {
  low: 0,
  medium: 1,
  high: 2,
  ultra: 3,
};

export function defaultTier(): number {
  if (typeof window === 'undefined') return 2;
  // Coarse pointers (phones, tablets) start a tier lower.
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const dpr = window.devicePixelRatio ?? 1;
  const base = dpr > 1.5 ? 2 : 3;
  return coarse ? Math.max(0, base - 1) : base;
}

/** Ignore the first moments of a match: shader compilation and texture generation are not tiers. */
const WARMUP_SECONDS = 4;
/** After changing tier the renderer rebuilds, which costs a frame. Do not read that frame. */
const SETTLE_SECONDS = 1.5;

/**
 * Measures real frame time over one-second windows and recommends a tier.
 *
 * Three things this has to get right, each of which was got wrong before:
 *
 * - **Warm-up.** The opening seconds of a match are slow because shaders are compiling and the
 *   kit/crowd textures are being generated, not because the tier is too high. Sampling them
 *   walked the ladder from Ultra to Low within five seconds of every kickoff.
 * - **Hitches.** A single long frame should not condemn a whole window, so the decision is made
 *   on the *median* frame time rather than the mean.
 * - **A reachable ceiling.** Stepping up required beating a fixed 58 fps, so anything capped
 *   below that — a 30 Hz panel, a throttled tab, vsync at 50 — could never climb back out of
 *   Low no matter how much headroom it had. The target now tracks the best frame rate actually
 *   observed, so the test is "is there headroom", not "is it 60 fps".
 */
export class FrameSampler {
  private frameTimes: number[] = [];
  private elapsed = 0;
  private goodWindows = 0;
  private warmup = 0;
  private settle = 0;
  /** Best frame rate seen so far, used as the achievable ceiling. */
  private ceiling = 0;
  fps = 60;
  private targetFps: number;

  constructor(targetFps = 58) {
    this.targetFps = targetFps;
  }

  /** Call after changing tier, so the rebuild frame is not mistaken for a slow tier. */
  notifyTierChange(): void {
    this.settle = SETTLE_SECONDS;
    this.frameTimes.length = 0;
    this.elapsed = 0;
    this.goodWindows = 0;
  }

  /**
   * Returns a tier delta (-1, 0 or +1) at most once per second.
   *
   * `dt` must be the *unclamped* frame time. Feeding it the clamped value used to advance the
   * simulation under-counts elapsed time on exactly the slow frames that matter, which reports
   * a healthy frame rate on a struggling machine and stops the quality ladder stepping down.
   */
  sample(dt: number): number {
    if (this.warmup < WARMUP_SECONDS) {
      this.warmup += dt;
      return 0;
    }
    if (this.settle > 0) {
      this.settle -= dt;
      return 0;
    }

    this.frameTimes.push(dt);
    this.elapsed += dt;
    if (this.elapsed < 1) return 0;

    // Median frame time: one 300 ms hitch in a good second must not read as 3 fps.
    const sorted = this.frameTimes.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 1 / 60;
    this.fps = 1 / median;
    this.frameTimes.length = 0;
    this.elapsed = 0;

    this.ceiling = Math.max(this.ceiling, this.fps);
    // Never demand more than this machine has been seen to manage, less a little slack.
    const target = Math.min(this.targetFps, this.ceiling * 0.95);

    if (this.fps < target - 10) {
      this.goodWindows = 0;
      return -1;
    }
    if (this.fps >= target) {
      this.goodWindows += 1;
      if (this.goodWindows >= 4) {
        this.goodWindows = 0;
        return 1;
      }
      return 0;
    }
    this.goodWindows = 0;
    return 0;
  }
}
