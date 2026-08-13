import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { CuboidCollider, CylinderCollider, RigidBody } from '@react-three/rapier';
import { CanvasTexture, RepeatWrapping, type Mesh } from 'three';
import { GOAL_DEPTH, GOAL_HEIGHT, HALF_GOAL_WIDTH, HALF_LENGTH, POST_RADIUS } from '../constants';
import { runtime } from '../runtime';

function createNetTexture(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.clearRect(0, 0, size, size);
  // Real netting is a diamond weave, not a grid: two diagonals plus the vertical cords.
  const cells = 10;
  const step = size / cells;
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  for (let i = -cells; i <= cells * 2; i++) {
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step + size, size);
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step - size, size);
  }
  for (let i = 0; i <= cells; i++) {
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step, size);
  }
  ctx.stroke();
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

interface GoalProps {
  /** +1 for the goal at +x. */
  dir: 1 | -1;
  shadows: boolean;
}

function Goal({ dir, shadows }: GoalProps) {
  const net = useMemo(() => {
    const t = createNetTexture();
    t.repeat.set(GOAL_DEPTH * 2.4, GOAL_HEIGHT * 2.4);
    return t;
  }, []);
  useEffect(() => () => net.dispose(), [net]);

  const backNet = useRef<Mesh | null>(null);
  const rest = useRef<Float32Array | null>(null);

  // The netting bulges where the ball hits it and shivers back to rest.
  useFrame((_state, delta) => {
    const mesh = backNet.current;
    if (!mesh) return;
    const attribute = mesh.geometry.getAttribute('position');
    if (!rest.current) rest.current = Float32Array.from(attribute.array);
    const hit = runtime.netHit;
    const active = hit && hit.dir === dir && hit.t > 0;
    if (!active) {
      if (mesh.userData.settled === true) return;
      attribute.array.set(rest.current);
      attribute.needsUpdate = true;
      mesh.userData.settled = true;
      return;
    }
    mesh.userData.settled = false;
    hit.t = Math.max(0, hit.t - delta);
    const decay = hit.t / 0.9;
    const amplitude = 0.55 * decay * decay;
    const wobble = Math.cos((1 - decay) * 34) * decay;
    for (let i = 0; i < attribute.count; i++) {
      // The plane is rotated into the yz face, so its local x/y are the goal's z/y.
      const px = rest.current[i * 3];
      const py = rest.current[i * 3 + 1];
      const d = Math.hypot(px + hit.z * dir, py - (hit.y - GOAL_HEIGHT / 2));
      const push = Math.exp(-d * d * 0.5) * amplitude * wobble;
      attribute.setZ(i, rest.current[i * 3 + 2] - push);
    }
    attribute.needsUpdate = true;
  });

  const line = HALF_LENGTH * dir;
  const back = (HALF_LENGTH + GOAL_DEPTH) * dir;
  const mid = (line + back) / 2;

  return (
    <group>
      {/* Frame: posts and crossbar are solid, so shots can rebound off them. */}
      <RigidBody type="fixed" colliders={false} restitution={0.62} friction={0.3}>
        {[HALF_GOAL_WIDTH, -HALF_GOAL_WIDTH].map((z) => (
          <group key={z} position={[line, GOAL_HEIGHT / 2, z]}>
            <mesh castShadow={shadows}>
              <cylinderGeometry args={[POST_RADIUS, POST_RADIUS, GOAL_HEIGHT, 12]} />
              <meshStandardMaterial color="#f8fafc" roughness={0.4} />
            </mesh>
            <CylinderCollider args={[GOAL_HEIGHT / 2, POST_RADIUS]} />
          </group>
        ))}
        <group position={[line, GOAL_HEIGHT, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <mesh castShadow={shadows}>
            <cylinderGeometry args={[POST_RADIUS, POST_RADIUS, HALF_GOAL_WIDTH * 2, 12]} />
            <meshStandardMaterial color="#f8fafc" roughness={0.4} />
          </mesh>
          <CylinderCollider args={[HALF_GOAL_WIDTH, POST_RADIUS]} />
        </group>
      </RigidBody>

      {/* Netting: damps the ball so it settles in the goal instead of bouncing back out. */}
      <RigidBody type="fixed" colliders={false} restitution={0.02} friction={0.9}>
        <CuboidCollider
          args={[0.05, GOAL_HEIGHT / 2, HALF_GOAL_WIDTH]}
          position={[back, GOAL_HEIGHT / 2, 0]}
        />
        {[HALF_GOAL_WIDTH, -HALF_GOAL_WIDTH].map((z) => (
          <CuboidCollider
            key={z}
            args={[GOAL_DEPTH / 2, GOAL_HEIGHT / 2, 0.05]}
            position={[mid, GOAL_HEIGHT / 2, z]}
          />
        ))}
        <CuboidCollider
          args={[GOAL_DEPTH / 2, 0.05, HALF_GOAL_WIDTH]}
          position={[mid, GOAL_HEIGHT, 0]}
        />
      </RigidBody>

      <mesh ref={backNet} position={[back, GOAL_HEIGHT / 2, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[HALF_GOAL_WIDTH * 2, GOAL_HEIGHT, 20, 12]} />
        <meshStandardMaterial
          map={net}
          transparent
          opacity={0.85}
          depthWrite={false}
          roughness={0.9}
          side={2}
        />
      </mesh>
      {[HALF_GOAL_WIDTH, -HALF_GOAL_WIDTH].map((z) => (
        <mesh key={z} position={[mid, GOAL_HEIGHT / 2, z]}>
          <planeGeometry args={[GOAL_DEPTH, GOAL_HEIGHT]} />
          <meshStandardMaterial
            map={net}
            transparent
            opacity={0.75}
            depthWrite={false}
            roughness={0.9}
            side={2}
          />
        </mesh>
      ))}
      <mesh position={[mid, GOAL_HEIGHT, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[GOAL_DEPTH, HALF_GOAL_WIDTH * 2]} />
        <meshStandardMaterial
          map={net}
          transparent
          opacity={0.7}
          depthWrite={false}
          roughness={0.9}
          side={2}
        />
      </mesh>
    </group>
  );
}

export function Goals({ shadows }: { shadows: boolean }) {
  return (
    <>
      <Goal dir={1} shadows={shadows} />
      <Goal dir={-1} shadows={shadows} />
    </>
  );
}
