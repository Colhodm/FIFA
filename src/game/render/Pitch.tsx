import { useEffect, useMemo } from 'react';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import { createPitchTexture, SURFACE_LENGTH, SURFACE_WIDTH } from './pitchTexture';

const WALL_HEIGHT = 14;

export function Pitch({ shadows }: { shadows: boolean }) {
  const texture = useMemo(() => createPitchTexture(2048), []);
  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow={shadows}>
        <planeGeometry args={[SURFACE_LENGTH, SURFACE_WIDTH]} />
        <meshStandardMaterial map={texture} roughness={0.96} metalness={0} />
      </mesh>

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
