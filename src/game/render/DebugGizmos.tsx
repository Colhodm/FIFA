import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { Group, Mesh } from 'three';
import { runtime } from '../runtime';
import type { SimWorld } from '../sim/state';

/** Length of a full-throw input arrow, in metres. */
const ARROW = 5;

/**
 * The 3D half of the F1 overlay (§6): the raw input vector and the camera-transformed world
 * vector drawn from the controlled player, the top switch candidates, and where the ball is
 * predicted to be. Seeing both arrows at once is what makes an inverted axis obvious.
 */
export function DebugGizmos({ world }: { world: SimWorld }) {
  const rawArrow = useRef<Group>(null);
  const worldArrow = useRef<Group>(null);
  const predicted = useRef<Mesh>(null);
  const candidates = useRef<Group>(null);

  useFrame(() => {
    const debug = runtime.debug;
    const active = world.players.find((p) => p.id === world.activeId);

    // Raw vector: drawn in screen space by rotating it with the camera, so it always reads as
    // "the direction you are pressing", whatever the camera is doing.
    // The two arrows sit at different heights: with a side-on camera they coincide exactly
    // (which is the point — the transform is correct), and they only separate when the camera
    // is rotated, so both need to stay readable.
    for (const [ref, vec, yaw, height] of [
      [rawArrow, debug.raw, runtime.cameraYaw, 0.5],
      [worldArrow, debug.world, 0, 0.12],
    ] as const) {
      const group = ref.current;
      if (!group) continue;
      const length = Math.hypot(vec.x, vec.z);
      group.visible = Boolean(active) && length > 0.01;
      if (!active || length <= 0.01) continue;
      const dir =
        yaw === 0
          ? vec
          : {
              x: vec.z * Math.sin(yaw) - vec.x * Math.cos(yaw),
              z: vec.z * Math.cos(yaw) + vec.x * Math.sin(yaw),
            };
      group.position.set(active.pos.x, height, active.pos.z);
      group.rotation.set(0, Math.atan2(dir.x, dir.z), 0);
      group.scale.set(1, 1, length * ARROW);
    }

    if (predicted.current) {
      predicted.current.position.set(debug.predicted.x, 0.12, debug.predicted.z);
    }

    // One ring per ranked candidate, brightest for the best.
    const group = candidates.current;
    if (group) {
      group.children.forEach((child, index) => {
        const candidate = debug.candidates[index];
        child.visible = Boolean(candidate);
        if (!candidate) return;
        const player = world.players.find((p) => p.id === candidate.id);
        if (!player) {
          child.visible = false;
          return;
        }
        child.position.set(player.pos.x, 0.1, player.pos.z);
      });
    }
  });

  return (
    <group>
      {/* Raw input: what the device reported. */}
      <group ref={rawArrow}>
        <mesh position={[0, 0, 0.5]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.07, 0.07, 1, 8]} />
          <meshBasicMaterial color="#facc15" depthTest={false} transparent opacity={0.95} />
        </mesh>
      </group>
      {/* Post-transform: what the player actually gets. */}
      <group ref={worldArrow}>
        <mesh position={[0, 0, 0.5]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.05, 0.05, 1, 8]} />
          <meshBasicMaterial color="#22d3ee" depthTest={false} transparent opacity={0.95} />
        </mesh>
      </group>

      <mesh ref={predicted} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.5, 0.75, 20]} />
        <meshBasicMaterial color="#f472b6" depthTest={false} transparent opacity={0.9} />
      </mesh>

      <group ref={candidates}>
        {[0, 1, 2].map((index) => (
          <mesh key={index} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.9, 1.1, 24]} />
            <meshBasicMaterial
              color="#4ade80"
              depthTest={false}
              transparent
              opacity={0.85 - index * 0.25}
            />
          </mesh>
        ))}
      </group>
    </group>
  );
}
