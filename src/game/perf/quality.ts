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
}

export const TIERS: QualityTier[] = [
  { id: 0, name: 'Low', dpr: 0.75, shadows: false, shadowMapSize: 512, crowdDensity: 0.15 },
  { id: 1, name: 'Medium', dpr: 1, shadows: true, shadowMapSize: 512, crowdDensity: 0.4 },
  { id: 2, name: 'High', dpr: 1.5, shadows: true, shadowMapSize: 1024, crowdDensity: 0.7 },
  { id: 3, name: 'Ultra', dpr: 2, shadows: true, shadowMapSize: 2048, crowdDensity: 1 },
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

/**
 * Measures real frame time over one-second windows and recommends a tier.
 * Steps down immediately when a window is slow, and only steps up after sustained headroom.
 */
export class FrameSampler {
  private frames = 0;
  private elapsed = 0;
  private goodWindows = 0;
  fps = 60;
  private targetFps: number;

  constructor(targetFps = 58) {
    this.targetFps = targetFps;
  }

  /** Returns a tier delta (-1, 0 or +1) at most once per second. */
  sample(dt: number): number {
    this.frames += 1;
    this.elapsed += dt;
    if (this.elapsed < 1) return 0;
    this.fps = this.frames / this.elapsed;
    this.frames = 0;
    this.elapsed = 0;
    if (this.fps < this.targetFps - 10) {
      this.goodWindows = 0;
      return -1;
    }
    if (this.fps > this.targetFps) {
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
