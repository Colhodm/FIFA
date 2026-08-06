import { useLayoutEffect, useMemo, useRef } from 'react';
import { Color, InstancedMesh, MathUtils, Object3D } from 'three';
import { SURFACE_LENGTH, SURFACE_WIDTH } from './pitchTexture';
import { mulberry32 } from '../sim/math';

const STAND_ROWS = 22;
const ROW_DEPTH = 1.1;
const ROW_RISE = 0.62;
const BASE_HEIGHT = 2.2;

const INNER_X = SURFACE_LENGTH / 2 + 2;
const INNER_Z = SURFACE_WIDTH / 2 + 2;
const ROOF_HEIGHT = BASE_HEIGHT + STAND_ROWS * ROW_RISE + 6;
/** First occupied row on the camera side of the ground. */
const GANTRY_ROW = 17;

/** Fictional sponsors: nothing here is a real brand. */
const BOARD_COLORS = ['#0f766e', '#1d4ed8', '#b91c1c', '#7c3aed', '#c2410c', '#0e7490'];

/** Seat rows form the terraces; crowd instances are scattered across them. */
function Terraces() {
  return (
    <group>
      {Array.from({ length: STAND_ROWS }, (_, row) => {
        const y = BASE_HEIGHT + row * ROW_RISE;
        const outX = INNER_X + row * ROW_DEPTH;
        const outZ = INNER_Z + row * ROW_DEPTH;
        const color = row % 2 === 0 ? '#111a28' : '#18243a';
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

/** Perimeter LED hoardings, the strongest "this is a broadcast" cue in the frame. */
function Hoardings() {
  const panelsX = 26;
  const panelsZ = 18;
  const spanX = (INNER_X * 2 - 4) / panelsX;
  const spanZ = (INNER_Z * 2 - 4) / panelsZ;
  return (
    <group>
      {Array.from({ length: panelsX }, (_, i) => {
        const x = -INNER_X + 2 + spanX * (i + 0.5);
        return [1, -1].map((s) => (
          <mesh key={`x${i}${s}`} position={[x, 0.55, (INNER_Z - 0.6) * s]}>
            <boxGeometry args={[spanX * 0.96, 1.1, 0.16]} />
            <meshStandardMaterial
              color={BOARD_COLORS[(i + (s > 0 ? 0 : 3)) % BOARD_COLORS.length]}
              emissive={BOARD_COLORS[(i + (s > 0 ? 0 : 3)) % BOARD_COLORS.length]}
              emissiveIntensity={0.55}
              roughness={0.4}
            />
          </mesh>
        ));
      })}
      {Array.from({ length: panelsZ }, (_, i) => {
        const z = -INNER_Z + 2 + spanZ * (i + 0.5);
        return [1, -1].map((s) => (
          <mesh
            key={`z${i}${s}`}
            position={[(INNER_X - 0.6) * s, 0.55, z]}
            rotation={[0, Math.PI / 2, 0]}
          >
            <boxGeometry args={[spanZ * 0.96, 1.1, 0.16]} />
            <meshStandardMaterial
              color={BOARD_COLORS[(i + (s > 0 ? 2 : 5)) % BOARD_COLORS.length]}
              emissive={BOARD_COLORS[(i + (s > 0 ? 2 : 5)) % BOARD_COLORS.length]}
              emissiveIntensity={0.55}
              roughness={0.4}
            />
          </mesh>
        ));
      })}
    </group>
  );
}

/** Cantilever roof: mostly there to cap the bowl and put the back rows in shade. */
function Roof() {
  const outX = INNER_X + STAND_ROWS * ROW_DEPTH;
  const outZ = INNER_Z + STAND_ROWS * ROW_DEPTH;
  // Only the back half is covered, so the broadcast gantry looks out from under it.
  const depth = STAND_ROWS * ROW_DEPTH * 0.5;
  return (
    <group>
      {[1, -1].map((s) => (
        <mesh key={`x${s}`} position={[(outX - depth / 2) * s, ROOF_HEIGHT, 0]}>
          <boxGeometry args={[depth, 0.5, outZ * 2]} />
          <meshStandardMaterial color="#e5e7eb" roughness={0.7} />
        </mesh>
      ))}
      {[1, -1].map((s) => (
        <mesh key={`z${s}`} position={[0, ROOF_HEIGHT, (outZ - depth / 2) * s]}>
          <boxGeometry args={[outX * 2, 0.5, depth]} />
          <meshStandardMaterial color="#e5e7eb" roughness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

interface CrowdProps {
  density: number;
}

/** One instanced mesh for the whole crowd keeps the stands to a single draw call. */
function Crowd({ density }: CrowdProps) {
  const ref = useRef<InstancedMesh>(null);
  const count = Math.max(400, Math.floor(11000 * density));

  const placements = useMemo(() => {
    const rand = mulberry32(1337);
    const dummy = new Object3D();
    const color = new Color();
    const matrices: number[][] = [];
    const colors: number[][] = [];
    const palette = [
      '#e2e8f0',
      '#cbd5f5',
      '#f87171',
      '#60a5fa',
      '#fbbf24',
      '#34d399',
      '#f472b6',
      '#1f2937',
      '#94a3b8',
    ];
    for (let i = 0; i < count; i++) {
      const side = Math.floor(rand() * 4);
      // The camera side is the TV gantry: leave its lower rows empty so no spectator ever
      // floats between the lens and the pitch.
      const row =
        side === 3
          ? GANTRY_ROW + Math.floor(rand() * (STAND_ROWS - GANTRY_ROW))
          : Math.floor(rand() * STAND_ROWS);
      const y = BASE_HEIGHT + row * ROW_RISE + ROW_RISE * 0.9;
      const outX = INNER_X + row * ROW_DEPTH;
      const outZ = INNER_Z + row * ROW_DEPTH;
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
  const height = ROOF_HEIGHT + 8;
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
      <Hoardings />
      <Terraces />
      <Crowd density={crowdDensity} />
      <Roof />
      <Floodlights />
    </group>
  );
}
