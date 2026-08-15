import type { PlayerRig } from '../runtime';
import type { SimPlayer } from '../sim/state';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** How long each clip runs, so `animTimer` can be turned into a 0..1 playhead. */
const CLIP_LENGTH: Record<string, number> = {
  kick: 0.3,
  shot: 0.45,
  'shot-finesse': 0.4,
  'shot-chip': 0.34,
  'shot-volley': 0.5,
  pass: 0.28,
  tackle: 0.3,
  slide: 0.8,
  dive: 0.9,
  jump: 0.7,
  skill: 0.45,
  feint: 0.26,
  throw: 0.5,
  celebrate: 1,
  down: 1.6,
};

/**
 * Poses one player's limb rig. Everything is procedural — no skinned meshes, no clips to
 * load — but each action has its own shape so a slide, a header and a celebration read
 * differently from the broadcast camera.
 */
export function poseRig(rig: PlayerRig, player: SimPlayer): void {
  const speed = Math.hypot(player.vel.x, player.vel.z);
  /*
   * Facing and travel are decoupled now: a jockeying defender shuffles sideways and back-pedals
   * while watching the ball. Running the full stride cycle while travelling across the facing
   * is a moonwalk, so the swing follows only the component of travel along the body, and the
   * lateral remainder becomes a side-step: shorter, quicker-looking, with the body dipped into
   * the direction of travel.
   */
  const facing = { x: Math.sin(player.heading), z: Math.cos(player.heading) };
  const along = speed > 0.3 ? (player.vel.x * facing.x + player.vel.z * facing.z) / speed : 1;
  const lateral = speed > 0.3 ? (player.vel.x * facing.z - player.vel.z * facing.x) / speed : 0;
  const stride = Math.min(1, speed / 7) * Math.max(0.25, Math.abs(along));
  const phase = player.gait * 2;
  const swing = Math.sin(phase) * stride * 0.85;
  const shuffle = Math.min(1, speed / 7) * Math.abs(lateral);

  // Baseline run cycle; each clip below layers on top of it.
  let legL = swing;
  let legR = -swing;
  let armL = -swing * 0.7;
  let armR = swing * 0.7;
  let lean = -stride * 0.12 * Math.sign(along || 1);
  // Dip into the side-step, and widen the legs a touch so it reads as a shuffle, not a glide.
  let roll = -lateral * 0.14;
  let twist = 0;
  let bob = Math.abs(Math.sin(phase)) * 0.05 * stride;
  /*
   * Knee flexion. The lower leg folds hardest just after toe-off, as the thigh swings through —
   * without it the legs scissor like a mannequin's, which was most of why the run looked wrong.
   * Positive x folds the shin backwards.
   */
  let shinL = stride * (0.18 + 1.05 * Math.max(0, -Math.sin(phase - 0.55)));
  let shinR = stride * (0.18 + 1.05 * Math.max(0, Math.sin(phase - 0.55)));
  // Sideways swing of the kicking leg: the finesse wrap and the volley need it; zero elsewhere.
  let legRz = shuffle * (0.18 + Math.abs(Math.sin(phase)) * 0.2) * Math.sign(lateral || 1);
  const legLz = -legRz;

  const length = CLIP_LENGTH[player.anim] ?? 0;
  // 0 at the start of the clip, 1 at the end.
  const t = length > 0 ? clamp01(1 - player.animTimer / length) : 0;

  /*
   * The backswing. While a strike is charging the kicking leg draws back and folds, the hips
   * close, and the body sinks into the plant — so the follow-through that fires on release
   * completes a swing instead of erupting from a jogging pose. Layered over a damped run cycle
   * because players do charge on the move; suppressed the moment a strike clip is playing.
   */
  const windup = player.animTimer > 0 ? 0 : player.windup;
  if (windup > 0.03) {
    const w = windup;
    const damp = 1 - w * 0.75;
    legL = swing * damp - 0.16 * w;
    legR = -swing * damp + 0.6 * w;
    shinR = shinR * damp + 0.95 * w;
    shinL = shinL * damp + 0.1 * w;
    armL = -swing * 0.7 * damp - 0.4 * w;
    armR = swing * 0.7 * damp + 0.55 * w;
    twist = 0.42 * w;
    lean = lean * damp + 0.05 * w;
    bob = bob * damp - 0.04 * w;
  }

  switch (player.anim) {
    /*
     * The ball leaves the boot on the very first frame of these clips, so they are
     * follow-throughs, not wind-ups: the leg is already through the ball at t = 0 and carries
     * on from there. Swinging up from nothing (the old shared `kick` clip) played the whole
     * motion *after* the ball had gone, which read as the player twitching at thin air.
     *
     * `contact` decays from the moment of impact; `lift` peaks mid-clip as the leg rises.
     */
    /*
     * Four strikes, four bodies. The laces drive throws everything through the ball; the
     * finesse opens the hips and wraps the instep around it; the chip stabs down under it and
     * stops; the volley swings the whole leg up at a ball off the floor. All are
     * follow-throughs — contact happens on the first frame.
     */
    case 'shot-finesse': {
      const contact = (1 - t) ** 0.75;
      const lift = Math.sin(t * Math.PI);
      // Side-foot wrap: hips open wide, the leg swings across the body, modest height.
      legR = -(0.85 * contact + 0.4 * lift);
      legRz = 0.55 * contact;
      shinR = 0.35 * contact;
      shinL = 0.2;
      legL = 0.35 * contact;
      armL = 0.9 * contact;
      armR = -0.75 * contact;
      twist = -0.62 * contact;
      lean = 0.14 * contact;
      break;
    }
    case 'shot-chip': {
      const contact = (1 - t) ** 0.9;
      // A stab under the ball: sharp, short, toe down and under, almost no follow-through —
      // the body stays tall and rocks back as the ball climbs away.
      legR = -0.55 * contact;
      shinR = 0.15 * contact;
      shinL = 0.2;
      legL = 0.2 * contact;
      armL = 0.5 * contact;
      armR = -0.4 * contact;
      lean = -0.18 * contact;
      bob = 0.03 * contact;
      break;
    }
    case 'shot-volley': {
      const contact = (1 - t) ** 0.65;
      const lift = Math.sin(t * Math.PI);
      // The leg swings up at a ball off the floor: near-horizontal thigh, body tipped away and
      // pivoting, arms flung out for balance, up on the standing toe.
      legR = -(1.6 * contact + 0.5 * lift);
      legRz = 0.3 * contact;
      shinR = 0.5 * contact;
      shinL = 0.25;
      legL = 0.4 * contact;
      armL = 1.4 * contact;
      armR = -1.1 * contact;
      roll = -0.22 * contact;
      lean = -0.12 * contact;
      twist = -0.3 * contact;
      bob = 0.09 * contact;
      break;
    }
    case 'shot': {
      const contact = (1 - t) ** 0.7;
      shinR = 0.9 * contact;
      shinL = 0.25;
      const lift = Math.sin(t * Math.PI);
      // Driving leg swings through and high, plant leg braced, hips open, chest over the ball.
      legR = -(1.25 * contact + 0.85 * lift);
      legL = 0.5 * contact;
      armL = 1.2 * contact + 0.45 * lift;
      armR = -0.8 * contact;
      lean = 0.3 * contact - 0.12 * lift;
      twist = -0.38 * contact;
      bob = 0.07 * lift;
      break;
    }
    case 'pass': {
      // Side-foot: short, compact, hips opened to the ball, very little follow-through.
      const contact = (1 - t) ** 0.8;
      shinR = 0.5 * contact;
      const lift = Math.sin(t * Math.PI);
      legR = -(0.72 * contact + 0.2 * lift);
      legL = 0.24 * contact;
      armL = 0.55 * contact;
      armR = -0.42 * contact;
      lean = 0.1 * contact;
      twist = -0.3 * contact;
      break;
    }
    case 'kick': {
      // Generic clearance: a firm hoof with a modest follow-through.
      const contact = (1 - t) ** 0.75;
      const lift = Math.sin(t * Math.PI);
      legR = -(1 * contact + 0.5 * lift);
      legL = 0.35 * contact;
      armL = 0.9 * contact;
      armR = -0.5 * contact;
      lean = 0.2 * contact;
      twist = -0.25 * contact;
      break;
    }
    case 'feint': {
      // Drop the shoulder and sell it: a hard lateral lean and a counter-swing of the arms, with
      // the feet barely leaving the ground. The heading has already been swung by the sim.
      const sell = Math.sin(t * Math.PI);
      lean = -0.12 * sell;
      twist = 0.55 * sell;
      armL = -0.9 * sell;
      armR = 0.7 * sell;
      legL = 0.3 * sell;
      legR = -0.22 * sell;
      bob = -0.05 * sell;
      break;
    }
    case 'throw': {
      // Two hands from behind the head, feet planted, body arching then snapping forward.
      const wind = Math.sin(clamp01(t / 0.45) * Math.PI * 0.5);
      const release = clamp01((t - 0.45) / 0.55);
      armL = -2.5 * wind + 1.9 * release;
      armR = -2.5 * wind + 1.9 * release;
      lean = -0.35 * wind + 0.45 * release;
      legL = 0.18 * wind;
      legR = -0.18 * wind;
      break;
    }
    case 'tackle': {
      const reach = Math.sin(t * Math.PI);
      legR = -1.1 * reach;
      lean = -0.5 * reach;
      armL = -0.8 * reach;
      armR = -0.8 * reach;
      break;
    }
    case 'slide': {
      // Down on one hip, trailing leg tucked, sliding through the challenge.
      const out = Math.sin(clamp01(t * 1.4) * Math.PI);
      lean = -1.15 * out;
      bob = -0.42 * out;
      legR = -1.3 * out;
      legL = -0.4 * out;
      armL = 1.1 * out;
      armR = 0.6 * out;
      break;
    }
    case 'dive': {
      // Full stretch across goal, the arms leading the way.
      const out = Math.sin(clamp01(t * 1.2) * Math.PI);
      roll = -player.diveDir * 1.35 * out;
      armL = -2.3 * out;
      armR = -2.3 * out;
      legL = 0.3 * out;
      legR = -0.3 * out;
      break;
    }
    case 'jump': {
      const up = Math.sin(t * Math.PI);
      legL = 0.7 * up;
      legR = 0.4 * up;
      armL = -2 * up;
      armR = -1.6 * up;
      lean = -0.25 * up;
      break;
    }
    case 'skill': {
      // Quick shift of weight over the ball.
      const shift = Math.sin(t * Math.PI * 2);
      twist = shift * 0.5;
      legL = shift * 0.9;
      legR = -shift * 0.9;
      armL = -shift * 0.6;
      armR = shift * 0.6;
      break;
    }
    case 'celebrate': {
      const pump = Math.sin(t * Math.PI * 3);
      armL = -2.6 - pump * 0.3;
      armR = -2.6 + pump * 0.3;
      lean = -0.18;
      break;
    }
    case 'down': {
      // Flat on the grass after the foul, then back up.
      const out = Math.sin(clamp01(t * 1.1) * Math.PI);
      lean = -1.5 * out;
      bob = -0.62 * out;
      legL = -0.2 * out;
      legR = 0.2 * out;
      armL = 0.4 * out;
      armR = -0.4 * out;
      break;
    }
    default:
      break;
  }

  rig.legL.rotation.x = legL;
  rig.shinL.rotation.x = shinL;
  rig.shinR.rotation.x = shinR;
  rig.legR.rotation.x = legR;
  // Written every frame: a clip that borrowed the z axis must not leave it behind.
  rig.legR.rotation.z = legRz;
  rig.legL.rotation.z = legLz;
  rig.armL.rotation.x = armL;
  rig.armR.rotation.x = armR;
  rig.torso.rotation.x = lean * 0.6;
  rig.torso.rotation.y = twist;
  rig.root.rotation.x = lean * 0.4;
  rig.root.rotation.z = roll;
  rig.root.position.y = player.height + bob;
}
