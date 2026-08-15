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

/**
 * Finishing is tuned here rather than in the integrator. Every "shooting feels wrong" report
 * should be answerable by these numbers: they set where the ball is *aimed* and how wide of that
 * a miss goes, and the solver then makes the physics agree.
 */
export interface ShotTuning extends PowerTuning {
  /** Charge above this buys power at the cost of placement. */
  overchargeThreshold: number;
  /** Metres of scatter at the goal plane for an unpressured, central, close-range shot. */
  baseSpread: number;
  /** Scatter doubles roughly every this many metres of range. */
  distanceSpreadMetres: number;
  /** Extra scatter per radian of angle away from a central position. */
  angleSpread: number;
  /** Extra scatter at full overcharge. */
  overchargeSpread: number;
  /** Extra scatter with a defender right on top of you. */
  pressureSpread: number;
  /**
   * Sidespin applied to a finesse shot. Lateral acceleration is `MAGNUS * spin * speed`, so 1.0
   * bends a 25 m/s strike about two metres over eighteen yards.
   */
  curlSpin: number;
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
  shot: ShotTuning;
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
    // A driven ground pass is 25-30 m/s in real football. The old 22 cap made a firm pass to a
    // man sixteen metres away saturate, so leaning on the button bought nothing.
    ground: { maxChargeSeconds: 1, minPowerFraction: 0.3, maxSpeed: 28 },
    lob: { maxChargeSeconds: 1, minPowerFraction: 0.3, maxSpeed: 18 },
    through: { maxChargeSeconds: 1, minPowerFraction: 0.3, maxSpeed: 20 },
    lobAngleDegrees: [30, 45],
    groundLeadSeconds: 0.25,
    coneDegrees: 35,
  },
  shot: {
    maxChargeSeconds: 1.2,
    minPowerFraction: 0.3,
    // A cleanly struck shot at full charge leaves the boot at 100 mph. The curve means only a
    // full charge from a settled body gets near it; a tap is 30% of this.
    maxSpeed: 44.7,
    overchargeThreshold: 0.85,
    baseSpread: 0.42,
    distanceSpreadMetres: 26,
    angleSpread: 0.9,
    overchargeSpread: 2.2,
    pressureSpread: 1.1,
    curlSpin: 1,
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
