import { useEffect, useMemo } from 'react';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import { HALF_LENGTH, HALF_WIDTH } from '../constants';
import { createPitchTexture, SURFACE_LENGTH, SURFACE_WIDTH } from './pitchTexture';

const WALL_HEIGHT = 14;
const FLAG_HEIGHT = 1.5;

const CORNERS: [number, number][] = [
  [HALF_LENGTH, HALF_WIDTH],
  [HALF_LENGTH, -HALF_WIDTH],
  [-HALF_LENGTH, HALF_WIDTH],
  [-HALF_LENGTH, -HALF_WIDTH],
];

export function Pitch({ shadows }: { shadows: boolean }) {
  const texture = useMemo(() => createPitchTexture(2048), []);
  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow={shadows}>
        <planeGeometry args={[SURFACE_LENGTH, SURFACE_WIDTH]} />
        <meshStandardMaterial map={texture} roughness={0.96} metalness={0} />
      </mesh>

      {CORNERS.map(([x, z]) => (
        <group key={`${x},${z}`} position={[x, 0, z]}>
          <mesh position={[0, FLAG_HEIGHT / 2, 0]} castShadow={shadows}>
            <cylinderGeometry args={[0.035, 0.035, FLAG_HEIGHT, 6]} />
            <meshStandardMaterial color="#e2e8f0" roughness={0.6} />
          </mesh>
          <mesh position={[0.16 * Math.sign(x), FLAG_HEIGHT - 0.2, 0]} castShadow={shadows}>
            <planeGeometry args={[0.32, 0.24]} />
            <meshStandardMaterial color="#facc15" roughness={0.8} side={2} />
          </mesh>
        </group>
      ))}

      <RigidBody type="fixed" colliders={false} friction={0.7} restitution={0.4}>
        <CuboidCollider
          args={[SURFACE_LENGTH / 2, 0.5, SURFACE_WIDTH / 2]}
          position={[0, -0.5, 0]}
        />
        {/* Perimeter walls keep a wild clearance inside the stadium. */}
        <CuboidCollider
          args={[0.5, WALL_HEIGHT, SURFACE_WIDTH / 2]}
          position={[SURFACE_LENGTH / 2, WALL_HEIGHT, 0]}
        />
        <CuboidCollider
          args={[0.5, WALL_HEIGHT, SURFACE_WIDTH / 2]}
          position={[-SURFACE_LENGTH / 2, WALL_HEIGHT, 0]}
        />
        <CuboidCollider
          args={[SURFACE_LENGTH / 2, WALL_HEIGHT, 0.5]}
          position={[0, WALL_HEIGHT, SURFACE_WIDTH / 2]}
        />
        <CuboidCollider
          args={[SURFACE_LENGTH / 2, WALL_HEIGHT, 0.5]}
          position={[0, WALL_HEIGHT, -SURFACE_WIDTH / 2]}
        />
      </RigidBody>
    </>
  );
}
