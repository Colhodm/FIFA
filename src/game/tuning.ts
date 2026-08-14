/**
 * Gameplay tunables that designers change more often than programmers do. Kept free of any
 * browser imports so the simulation and the Node sim-harness can both pull it in; the loader
 * that layers `public/config/tuning.json` over these lives in `config.ts`.
 */

export interface PowerTuning {
  /** Seconds of hold that reaches full power. */
  maxChargeSeconds: number;
  /** Fraction of full power a bare tap produces. */
  minPowerFraction: number;
  /** Ball speed at full charge, m/s. */
  maxSpeed: number;
}

export interface Tuning {
  pass: {
    ground: PowerTuning;
    lob: PowerTuning;
    through: PowerTuning;
    /** Launch angle range for a lob, degrees, interpolated by power. */
    lobAngleDegrees: [number, number];
    /** Seconds of the receiver's run a ground pass leads by. */
    groundLeadSeconds: number;
    /** Half-angle of the cone searched for a receiver, degrees. */
    coneDegrees: number;
  };
  shot: PowerTuning & {
    /** Charge above this starts to spray, up to `overchargeConeDegrees`. */
    overchargeThreshold: number;
    overchargeConeDegrees: number;
  };
  /** Weights for the player-switch scoring function. */
  switching: {
    predictedDistance: number;
    currentDistance: number;
    anglePenalty: number;
    /** Seconds of ball velocity used to predict where play is going. */
    predictSeconds: number;
    /** A second press inside this window cycles the ranking instead of re-ranking. */
    cycleWindowSeconds: number;
    /** Auto-switch stays out of the way for this long after a manual switch. */
    manualHoldSeconds: number;
  };
}

export const DEFAULT_TUNING: Tuning = {
  pass: {
    ground: { maxChargeSeconds: 1, minPowerFraction: 0.3, maxSpeed: 22 },
    lob: { maxChargeSeconds: 1, minPowerFraction: 0.3, maxSpeed: 18 },
    through: { maxChargeSeconds: 1, minPowerFraction: 0.3, maxSpeed: 20 },
    lobAngleDegrees: [30, 45],
    groundLeadSeconds: 0.25,
    coneDegrees: 35,
  },
  shot: {
    maxChargeSeconds: 1.2,
    minPowerFraction: 0.3,
    maxSpeed: 30,
    overchargeThreshold: 0.85,
    overchargeConeDegrees: 8,
  },
  switching: {
    predictedDistance: 1,
    currentDistance: 0.4,
    anglePenalty: 0.3,
    predictSeconds: 0.5,
    cycleWindowSeconds: 0.8,
    manualHoldSeconds: 0.5,
  },
};
