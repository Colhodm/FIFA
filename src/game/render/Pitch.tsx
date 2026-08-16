import { useEffect, useMemo } from 'react';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import { RepeatWrapping } from 'three';
import { HALF_LENGTH, HALF_WIDTH } from '../constants';
import { createPitchTexture, SURFACE_LENGTH, SURFACE_WIDTH } from './pitchTexture';
import { grassNormalTexture } from './textures';

const WALL_HEIGHT = 14;
const FLAG_HEIGHT = 1.5;
/** Concrete apron between the grass and the first row of hoardings. */
const APRON_LENGTH = SURFACE_LENGTH + 14;
const APRON_WIDTH = SURFACE_WIDTH + 14;

const CORNERS: [number, number][] = [
  [HALF_LENGTH, HALF_WIDTH],
  [HALF_LENGTH, -HALF_WIDTH],
  [-HALF_LENGTH, HALF_WIDTH],
  [-HALF_LENGTH, -HALF_WIDTH],
];

export function Pitch({ shadows, wet }: { shadows: boolean; wet: boolean }) {
  const texture = useMemo(() => createPitchTexture(4096), []);
  useEffect(() => () => texture.dispose(), [texture]);

  // The blade noise is tiled far more densely than the markings, which keeps the lines crisp
  // while the surface itself still has grass-scale detail under the lights.
  const normal = useMemo(() => {
    const map = grassNormalTexture().clone();
    map.wrapS = RepeatWrapping;
    map.wrapT = RepeatWrapping;
    map.repeat.set(SURFACE_LENGTH / 2.5, SURFACE_WIDTH / 2.5);
    map.needsUpdate = true;
    return map;
  }, []);
  useEffect(() => () => normal.dispose(), [normal]);

  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow={false}>
        <planeGeometry args={[APRON_LENGTH, APRON_WIDTH]} />
        <meshStandardMaterial color="#2a3040" roughness={0.95} />
      </mesh>

      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow={shadows}>
        <planeGeometry args={[SURFACE_LENGTH, SURFACE_WIDTH]} />
        <meshStandardMaterial
          map={texture}
          normalMap={normal}
          normalScale={[0.55, 0.55]}
          roughness={wet ? 0.45 : 0.82}
          metalness={0}
          envMapIntensity={wet ? 0.9 : 0.35}
        />
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
