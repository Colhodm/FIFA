/**
 * Pitch space: x = length (goal to goal), z = width (touchline to touchline), y = up.
 * All gameplay math lives in this space; the renderer maps it 1:1 to world units.
 */

export const PITCH_LENGTH = 105;
export const PITCH_WIDTH = 68;
export const HALF_LENGTH = PITCH_LENGTH / 2;
export const HALF_WIDTH = PITCH_WIDTH / 2;

export const GOAL_WIDTH = 7.32;
export const GOAL_HEIGHT = 2.44;
export const GOAL_DEPTH = 2;
export const POST_RADIUS = 0.06;
export const HALF_GOAL_WIDTH = GOAL_WIDTH / 2;

export const PENALTY_BOX_DEPTH = 16.5;
export const PENALTY_BOX_WIDTH = 40.32;
export const GOAL_BOX_DEPTH = 5.5;
export const GOAL_BOX_WIDTH = 18.32;
export const CENTER_CIRCLE_RADIUS = 9.15;
export const PENALTY_SPOT_DISTANCE = 11;
export const CORNER_ARC_RADIUS = 1;

export const BALL_RADIUS = 0.11;
export const BALL_MASS = 0.43;

export const PLAYER_RADIUS = 0.38;
export const PLAYER_HEIGHT = 1.8;

/** Fixed simulation tick. Physics, AI and input sampling all advance in these steps. */
export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
/**
 * Never advance more than this many ticks in one frame (avoids spiral of death after a stall).
 * This is the catch-up budget: at 60 Hz it lets a frame absorb 200 ms of backlog, so an ordinary
 * hitch is caught up rather than discarded. Set it too low and the match silently runs in slow
 * motion on any machine that dips below `TICK_RATE / MAX_TICKS_PER_FRAME` fps.
 */
export const MAX_TICKS_PER_FRAME = 12;

/** Distance at which a player can take a touch on the ball. */
export const CONTROL_RADIUS = 1.25;
/** Seconds a player cannot re-take the ball after kicking it. */
export const KICK_COOLDOWN = 0.35;

export const BASE_SPEED = 6.2;
export const SPRINT_MULTIPLIER = 1.42;
export const ACCELERATION = 22;
export const TURN_RATE = 7.5;

export const STAMINA_DRAIN_SPRINT = 0.085;
export const STAMINA_DRAIN_RUN = 0.012;
export const STAMINA_RECOVERY = 0.05;

/** Height a jumping player can reach the ball at, and how high he leaves the ground. */
export const HEADER_HEIGHT = 2.5;
export const JUMP_HEIGHT = 0.62;
/** Wall distance and the arc a defensive wall covers, from the laws of the game. */
export const WALL_DISTANCE = 9.15;

export const MAX_SHOT_POWER = 28;
export const MIN_SHOT_POWER = 12;
export const MAX_PASS_POWER = 20;
export const MIN_PASS_POWER = 7;
/** Seconds of button hold that maps to full power. */
export const CHARGE_TIME = 0.8;

/** Sideways acceleration per unit of spin per m/s of pace: the Magnus effect on a curled ball. */
export const MAGNUS = 0.42;
/** Spin decays this fast in flight (fraction remaining per second). */
export const SPIN_DECAY = 0.55;
