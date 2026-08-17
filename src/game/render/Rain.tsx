import { useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { InstancedMesh, Object3D } from 'three';
import { mulberry32 } from '../sim/math';

const COUNT = 1400;
const AREA_X = 130;
const AREA_Z = 100;
const TOP = 42;
const FALL = 34;

/**
 * Rain as instanced streaks: thin stretched boxes falling over the bowl, each on its own loop.
 * One draw call, no per-drop allocation — the same trick the crowd uses.
 */
export function Rain() {
  const ref = useRef<InstancedMesh>(null);
  const drops = useMemo(() => {
    const rand = mulberry32(2024);
    return Array.from({ length: COUNT }, () => ({
      x: (rand() * 2 - 1) * (AREA_X / 2),
      z: (rand() * 2 - 1) * (AREA_Z / 2),
      phase: rand() * TOP,
      speed: FALL * (0.85 + rand() * 0.3),
      drift: (rand() * 2 - 1) * 2.5,
    }));
  }, []);

  const dummy = useMemo(() => new Object3D(), []);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    mesh.count = COUNT;
  }, []);

  useFrame((state) => {
    const mesh = ref.current;
    if (!mesh) return;
    const t = state.clock.elapsedTime;
    for (let i = 0; i < COUNT; i++) {
      const drop = drops[i];
      const y = TOP - ((drop.phase + t * drop.speed) % TOP);
      dummy.position.set(drop.x + drop.drift * (y / TOP), y, drop.z);
      // Lean the streak into its sideways drift so the fall reads as one direction of travel.
      dummy.rotation.set(0, 0, -drop.drift / FALL);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, COUNT]} frustumCulled={false}>
      <boxGeometry args={[0.02, 0.55, 0.02]} />
      <meshBasicMaterial color="#aebfd4" transparent opacity={0.4} />
    </instancedMesh>
  );
}
