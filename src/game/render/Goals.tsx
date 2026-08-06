import { useEffect, useMemo } from 'react';
import { CuboidCollider, CylinderCollider, RigidBody } from '@react-three/rapier';
import { CanvasTexture, RepeatWrapping } from 'three';
import { GOAL_DEPTH, GOAL_HEIGHT, HALF_GOAL_WIDTH, HALF_LENGTH, POST_RADIUS } from '../constants';

function createNetTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 3;
  const cells = 8;
  for (let i = 0; i <= cells; i++) {
    const p = (i / cells) * size;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
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
    t.repeat.set(GOAL_DEPTH * 1.5, GOAL_HEIGHT * 1.5);
    return t;
  }, []);
  useEffect(() => () => net.dispose(), [net]);

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

      <mesh position={[back, GOAL_HEIGHT / 2, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[HALF_GOAL_WIDTH * 2, GOAL_HEIGHT]} />
        <meshBasicMaterial map={net} transparent opacity={0.55} depthWrite={false} />
      </mesh>
      {[HALF_GOAL_WIDTH, -HALF_GOAL_WIDTH].map((z) => (
        <mesh key={z} position={[mid, GOAL_HEIGHT / 2, z]}>
          <planeGeometry args={[GOAL_DEPTH, GOAL_HEIGHT]} />
          <meshBasicMaterial map={net} transparent opacity={0.45} depthWrite={false} side={2} />
        </mesh>
      ))}
      <mesh position={[mid, GOAL_HEIGHT, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[GOAL_DEPTH, HALF_GOAL_WIDTH * 2]} />
        <meshBasicMaterial map={net} transparent opacity={0.4} depthWrite={false} side={2} />
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
