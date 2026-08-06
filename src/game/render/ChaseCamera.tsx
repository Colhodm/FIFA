import { useFrame, useThree } from '@react-three/fiber';
import { useRef } from 'react';
import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { runtime } from '../runtime';
import { smoothing } from '../sim/math';

/** Horizontal field of view; the vertical FOV three.js wants is derived from the live aspect. */
const TARGET_HFOV_DEG = 82;

const FOLLOW_DISTANCE = 13.5;
const FOLLOW_HEIGHT = 7.2;
const LOOK_AHEAD = 6;

export function ChaseCamera() {
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
    const broadcast =
      world.phase === 'kickoff' ||
      world.phase === 'goal' ||
      world.phase === 'halftime' ||
      world.phase === 'end';

    let lookX = 0;
    let lookZ = 1;

    if (broadcast || !active) {
      desiredFocus.current.set(ball.x * 0.85, 1.5, ball.z * 0.4);
      desiredPos.current.set(ball.x * 0.6, 26, -48);
      lookX = desiredFocus.current.x - desiredPos.current.x;
      lookZ = desiredFocus.current.z - desiredPos.current.z;
    } else {
      const attack = world.attackDir[active.side];
      const toBallX = ball.x - active.pos.x;
      const toBallZ = ball.z - active.pos.z;
      const toBallLen = Math.hypot(toBallX, toBallZ) || 1;
      // Look mostly up the pitch, leaning towards the ball.
      const mixX = attack * 0.75 + (toBallX / toBallLen) * 0.25;
      const mixZ = (toBallZ / toBallLen) * 0.25;
      const mixLen = Math.hypot(mixX, mixZ) || 1;
      lookX = mixX / mixLen;
      lookZ = mixZ / mixLen;

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
    }

    focus.current.lerp(desiredFocus.current, smoothing(dt, 0.18));
    position.current.lerp(desiredPos.current, smoothing(dt, 0.24));
    camera.position.copy(position.current);
    camera.lookAt(focus.current);

    // Subtle roll into turns.
    const lateral = active ? active.vel.x * -lookZ + active.vel.z * lookX : 0;
    roll.current = MathUtils.lerp(
      roll.current,
      MathUtils.clamp(lateral * 0.008, -0.05, 0.05),
      smoothing(dt, 0.3),
    );
    camera.rotateZ(roll.current);

    runtime.cameraYaw = Math.atan2(lookX, lookZ);
  });

  return null;
}
