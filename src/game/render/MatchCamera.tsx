import { useFrame, useThree } from '@react-three/fiber';
import { useRef } from 'react';
import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { HALF_LENGTH, HALF_WIDTH } from '../constants';
import { runtime } from '../runtime';
import { smoothing } from '../sim/math';
import type { CameraMode } from '../store';

/** Horizontal field of view; the vertical FOV three.js wants is derived from the live aspect. */
const TARGET_HFOV_DEG = 78;

/**
 * Side-on rigs, like FIFA's Tele and Broadcast presets: the camera stays on one touchline and
 * dollies along it, so the pitch always reads left-to-right and the attacking direction is
 * stable. `height`/`back` set the angle, `track` how much of the ball's width it follows.
 */
const RIGS: Record<'broadcast' | 'tele', { height: number; back: number; track: number }> = {
  broadcast: { height: 17, back: 26, track: 0.55 },
  tele: { height: 30, back: 30, track: 0.35 },
};

/** Player cam sits behind the man on the ball and looks up the pitch. */
const FOLLOW_DISTANCE = 13.5;
const FOLLOW_HEIGHT = 7.2;
const LOOK_AHEAD = 6;

export function MatchCamera({ mode }: { mode: CameraMode }) {
  const { camera, size } = useThree();
  const focus = useRef(new Vector3(0, 0, 0));
  const position = useRef(new Vector3(0, 24, -34));
  const desiredFocus = useRef(new Vector3());
  const desiredPos = useRef(new Vector3());
  const roll = useRef(0);

  useFrame((_state, delta) => {
    const world = runtime.world;
    if (!world) return;
    const dt = Math.min(delta, 0.1);

    if (camera instanceof PerspectiveCamera) {
      const aspect = size.width / Math.max(1, size.height);
      const hFov = MathUtils.degToRad(TARGET_HFOV_DEG);
      const vFov = MathUtils.radToDeg(2 * Math.atan(Math.tan(hFov / 2) / aspect));
      if (Math.abs(camera.fov - vFov) > 0.01) {
        camera.fov = vFov;
        camera.updateProjectionMatrix();
      }
    }

    const ball = world.ball.pos;
    const active = world.players.find((p) => p.id === world.activeId);
    // Dead-ball moments always cut to the high wide angle, whatever the chosen rig.
    const cutaway =
      world.phase === 'kickoff' ||
      world.phase === 'goal' ||
      world.phase === 'halftime' ||
      world.phase === 'end';

    if (mode === 'player' && active && !cutaway) {
      const attack = world.attackDir[active.side];
      const toBallX = ball.x - active.pos.x;
      const toBallZ = ball.z - active.pos.z;
      const toBallLen = Math.hypot(toBallX, toBallZ) || 1;
      // Look mostly up the pitch, leaning towards the ball.
      const mixX = attack * 0.75 + (toBallX / toBallLen) * 0.25;
      const mixZ = (toBallZ / toBallLen) * 0.25;
      const mixLen = Math.hypot(mixX, mixZ) || 1;
      const lookX = mixX / mixLen;
      const lookZ = mixZ / mixLen;

      desiredFocus.current.set(
        active.pos.x + lookX * LOOK_AHEAD,
        1.4,
        active.pos.z + lookZ * LOOK_AHEAD,
      );
      desiredPos.current.set(
        active.pos.x - lookX * FOLLOW_DISTANCE,
        FOLLOW_HEIGHT,
        active.pos.z - lookZ * FOLLOW_DISTANCE,
      );
    } else {
      const rig = cutaway ? RIGS.tele : RIGS[mode === 'tele' ? 'tele' : 'broadcast'];
      // Frame the play, not just the ball: the midpoint of ball and the man you control.
      const cx = active && !cutaway ? (ball.x * 2 + active.pos.x) / 3 : ball.x;
      const cz = active && !cutaway ? (ball.z * 2 + active.pos.z) / 3 : ball.z;
      // Ease off near the goal lines so the camera never stares past the stands.
      const panX = MathUtils.clamp(cx, -HALF_LENGTH + 14, HALF_LENGTH - 14);
      // The rig only dollies along the touchline; the width of play is handled by the look-at,
      // so the camera can never end up inside the stands or over the pitch.
      desiredFocus.current.set(panX, 1.6, cz * rig.track);
      desiredPos.current.set(panX * 0.92, rig.height, -HALF_WIDTH - rig.back);
    }

    // The wide rigs glide; the player cam has to keep up with a sprinting winger.
    const lag = mode === 'player' ? 0.18 : 0.3;
    focus.current.lerp(desiredFocus.current, smoothing(dt, lag));
    position.current.lerp(desiredPos.current, smoothing(dt, lag + 0.06));
    camera.position.copy(position.current);
    camera.lookAt(focus.current);

    const lookX = focus.current.x - position.current.x;
    const lookZ = focus.current.z - position.current.z;

    // Subtle roll into turns, player cam only — a broadcast rig is on a level dolly.
    const targetRoll =
      mode === 'player' && active
        ? MathUtils.clamp((active.vel.x * -lookZ + active.vel.z * lookX) * 0.008, -0.05, 0.05)
        : 0;
    roll.current = MathUtils.lerp(roll.current, targetRoll, smoothing(dt, 0.3));
    if (roll.current) camera.rotateZ(roll.current);

    // Movement input is camera-relative, so the stick always points where the screen does.
    runtime.cameraYaw = Math.atan2(lookX, lookZ);
  });

  return null;
}
