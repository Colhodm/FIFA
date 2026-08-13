import type { PlayerRig } from '../runtime';
import type { SimPlayer } from '../sim/state';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** How long each clip runs, so `animTimer` can be turned into a 0..1 playhead. */
const CLIP_LENGTH: Record<string, number> = {
  kick: 0.3,
  tackle: 0.3,
  slide: 0.8,
  dive: 0.9,
  jump: 0.7,
  skill: 0.45,
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
  const stride = Math.min(1, speed / 7);
  const phase = player.gait * 2;
  const swing = Math.sin(phase) * stride * 0.85;

  // Baseline run cycle; each clip below layers on top of it.
  let legL = swing;
  let legR = -swing;
  let armL = -swing * 0.7;
  let armR = swing * 0.7;
  let lean = -stride * 0.12;
  let roll = 0;
  let twist = 0;
  let bob = Math.abs(Math.sin(phase)) * 0.05 * stride;

  const length = CLIP_LENGTH[player.anim] ?? 0;
  // 0 at the start of the clip, 1 at the end.
  const t = length > 0 ? clamp01(1 - player.animTimer / length) : 0;

  switch (player.anim) {
    case 'kick': {
      // Plant, swing through, follow through.
      const strike = Math.sin(t * Math.PI);
      legR = -1.5 * strike;
      legL = 0.35 * strike;
      armL = 0.9 * strike;
      armR = -0.5 * strike;
      lean = 0.18 * strike;
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
  rig.legR.rotation.x = legR;
  rig.armL.rotation.x = armL;
  rig.armR.rotation.x = armR;
  rig.torso.rotation.x = lean * 0.6;
  rig.torso.rotation.y = twist;
  rig.root.rotation.x = lean * 0.4;
  rig.root.rotation.z = roll;
  rig.root.position.y = player.height + bob;
}
