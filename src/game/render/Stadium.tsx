import { useLayoutEffect, useMemo, useRef } from 'react';
import { Color, InstancedMesh, MathUtils, Object3D } from 'three';
import { SURFACE_LENGTH, SURFACE_WIDTH } from './pitchTexture';
import { mulberry32 } from '../sim/math';

const STAND_ROWS = 14;
const ROW_DEPTH = 1.1;
const ROW_RISE = 0.55;
const BASE_HEIGHT = 1.6;

const INNER_X = SURFACE_LENGTH / 2 + 2;
const INNER_Z = SURFACE_WIDTH / 2 + 2;

/** Seat rows form the terraces; crowd instances are scattered across them. */
function Terraces() {
  return (
    <group>
      {Array.from({ length: STAND_ROWS }, (_, row) => {
        const y = BASE_HEIGHT + row * ROW_RISE;
        const outX = INNER_X + row * ROW_DEPTH;
        const outZ = INNER_Z + row * ROW_DEPTH;
        const color = row % 2 === 0 ? '#1f2937' : '#243347';
        return (
          <group key={row}>
            {[1, -1].map((s) => (
              <mesh key={`x${s}`} position={[outX * s, y, 0]}>
                <boxGeometry args={[ROW_DEPTH, ROW_RISE, outZ * 2 + ROW_DEPTH * 2]} />
                <meshStandardMaterial color={color} roughness={1} />
              </mesh>
            ))}
            {[1, -1].map((s) => (
              <mesh key={`z${s}`} position={[0, y, outZ * s]}>
                <boxGeometry args={[outX * 2, ROW_RISE, ROW_DEPTH]} />
                <meshStandardMaterial color={color} roughness={1} />
              </mesh>
            ))}
          </group>
        );
      })}
    </group>
  );
}

interface CrowdProps {
  density: number;
}

/** One instanced mesh for the whole crowd keeps the stands to a single draw call. */
function Crowd({ density }: CrowdProps) {
  const ref = useRef<InstancedMesh>(null);
  const count = Math.max(200, Math.floor(6000 * density));

  const placements = useMemo(() => {
    const rand = mulberry32(1337);
    const dummy = new Object3D();
    const color = new Color();
    const matrices: number[][] = [];
    const colors: number[][] = [];
    const palette = ['#e2e8f0', '#f87171', '#60a5fa', '#fbbf24', '#34d399', '#f472b6'];
    for (let i = 0; i < count; i++) {
      const row = Math.floor(rand() * STAND_ROWS);
      const y = BASE_HEIGHT + row * ROW_RISE + ROW_RISE * 0.9;
      const outX = INNER_X + row * ROW_DEPTH;
      const outZ = INNER_Z + row * ROW_DEPTH;
      const side = Math.floor(rand() * 4);
      if (side < 2) {
        const s = side === 0 ? 1 : -1;
        dummy.position.set(outX * s, y, MathUtils.lerp(-outZ, outZ, rand()));
      } else {
        const s = side === 2 ? 1 : -1;
        dummy.position.set(MathUtils.lerp(-outX, outX, rand()), y, outZ * s);
      }
      dummy.rotation.set(0, rand() * Math.PI, 0);
      dummy.scale.setScalar(0.75 + rand() * 0.35);
      dummy.updateMatrix();
      matrices.push([...dummy.matrix.elements]);
      color.set(palette[Math.floor(rand() * palette.length)]);
      colors.push([color.r, color.g, color.b]);
    }
    return { matrices, colors };
  }, [count]);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const dummy = new Object3D();
    placements.matrices.forEach((elements, i) => {
      dummy.matrix.fromArray(elements);
      mesh.setMatrixAt(i, dummy.matrix);
      const [r, g, b] = placements.colors[i];
      mesh.setColorAt(i, new Color(r, g, b));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [placements]);

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]} frustumCulled={false}>
      <boxGeometry args={[0.42, 0.7, 0.42]} />
      <meshStandardMaterial roughness={0.9} />
    </instancedMesh>
  );
}

function Floodlights() {
  const height = BASE_HEIGHT + STAND_ROWS * ROW_RISE + 12;
  const x = INNER_X + STAND_ROWS * ROW_DEPTH;
  const z = INNER_Z + STAND_ROWS * ROW_DEPTH;
  return (
    <group>
      {[
        [x, z],
        [x, -z],
        [-x, z],
        [-x, -z],
      ].map(([px, pz]) => (
        <group key={`${px},${pz}`} position={[px, 0, pz]}>
          <mesh position={[0, height / 2, 0]}>
            <cylinderGeometry args={[0.4, 0.6, height, 8]} />
            <meshStandardMaterial color="#64748b" roughness={0.8} />
          </mesh>
          <mesh position={[0, height, 0]}>
            <boxGeometry args={[6, 2.4, 1]} />
            <meshStandardMaterial color="#e2e8f0" emissive="#fef9c3" emissiveIntensity={1.6} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

export function Stadium({ crowdDensity }: { crowdDensity: number }) {
  return (
    <group>
      <Terraces />
      <Crowd density={crowdDensity} />
      <Floodlights />
    </group>
  );
}
