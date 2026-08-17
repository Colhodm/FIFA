import { useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import {
  BoxGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  Object3D,
  SphereGeometry,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SURFACE_LENGTH, SURFACE_WIDTH } from './pitchTexture';
import { facadeTexture, hoardingTexture, seatTexture } from './textures';
import { mulberry32 } from '../sim/math';

/** Inner edge of the bowl, just outside the run-off. */
const INNER_X = SURFACE_LENGTH / 2 + 6;
const INNER_Z = SURFACE_WIDTH / 2 + 6;

interface TierSpec {
  /** Distance the tier's front edge sits back from the bowl's inner edge. */
  inset: number;
  /** Height of the tier's front edge above the pitch. */
  base: number;
  /** Horizontal depth from front to back. */
  depth: number;
  /** Vertical climb from front to back. */
  rise: number;
  rows: number;
}

const LOWER: TierSpec = { inset: 0, base: 1.6, depth: 15, rise: 10, rows: 22 };
/** The second deck is set back over the rear of the first, the way a real two-tier bowl stacks. */
const UPPER: TierSpec = { inset: 9, base: 17, depth: 15, rise: 12.5, rows: 24 };
/** Where the upper deck's fascia meets the lower terrace, so the wall is not a black slab. */
/** The Kop's upper bank starts lower and rakes further, so it reads as one continuous wall. */
const KOP_UPPER: TierSpec = { inset: 6, base: 13, depth: 19, rise: 17, rows: 34 };

const FASCIA_BOTTOM = LOWER.base + LOWER.rise * (UPPER.inset / LOWER.depth);
const ROOF_Y = UPPER.base + UPPER.rise + 5.5;
/** The near touchline is the TV side: its lower tier is the camera gantry, so it stays empty. */
const CAMERA_SIDE_Z = -1;

type Side = { axis: 'x' | 'z'; sign: 1 | -1 };
const SIDES: Side[] = [
  { axis: 'x', sign: 1 },
  { axis: 'x', sign: -1 },
  { axis: 'z', sign: 1 },
  { axis: 'z', sign: -1 },
];

/** Half-length of a stand along its own run, plus the corner overlap. */
function span(side: Side): number {
  return side.axis === 'x' ? INNER_Z + UPPER.depth : INNER_X + UPPER.depth;
}

/** World position of a seat at (u along the stand, v up the rake) on one tier. */
function seatPosition(side: Side, tier: TierSpec, u: number, v: number): [number, number, number] {
  const inner = (side.axis === 'x' ? INNER_X : INNER_Z) + tier.inset;
  const out = (inner + tier.depth * v) * side.sign;
  const along = u * span(side);
  const y = tier.base + tier.rise * v;
  return side.axis === 'x' ? [out, y, along] : [along, y, out];
}

/** One raked seating deck, textured with rows of tip-up seats. */
function Deck({ side, tier, primary, accent }: { side: Side; tier: TierSpec } & Palette) {
  const texture = useMemo(() => {
    const map = seatTexture(primary, accent).clone();
    map.repeat.set(Math.round(span(side) / 1.4), tier.rows / 12);
    map.needsUpdate = true;
    return map;
  }, [side, tier, primary, accent]);

  const slope = Math.hypot(tier.depth, tier.rise);
  const angle = Math.atan2(tier.rise, tier.depth);
  const inner = (side.axis === 'x' ? INNER_X : INNER_Z) + tier.inset;
  const mid = inner + tier.depth / 2;
  const midY = tier.base + tier.rise / 2;
  const length = span(side) * 2;
  const bottom = tier.inset > 0 ? FASCIA_BOTTOM : 0;
  const facade = facadeTexture();
  // Yaw that turns the stand's local +Z into the direction of the pitch.
  const yaw = side.axis === 'x' ? -side.sign * (Math.PI / 2) : side.sign > 0 ? Math.PI : 0;

  return (
    <group rotation={[0, yaw, 0]}>
      {/*
        Local space: +Z faces the pitch, so the deck is a plane tilted back from horizontal by
        its rake, and "up the terrace" runs away from the touchline.
      */}
      <mesh position={[0, midY, -mid]} rotation={[-(Math.PI / 2 - angle), 0, 0]}>
        <planeGeometry args={[length, slope]} />
        <meshStandardMaterial map={texture} roughness={0.9} />
      </mesh>
      {/* Front wall below the deck, holding the terrace up off the run-off. */}
      <mesh position={[0, (tier.base + bottom) / 2, -inner]}>
        <boxGeometry args={[length, tier.base - bottom, 0.6]} />
        <meshStandardMaterial color={bottom > 0 ? '#1c2637' : '#111827'} roughness={0.9} />
      </mesh>
      {bottom > 0 && (
        <>
          {/* Hospitality boxes: a lit glass ribbon splits the two decks. */}
          {/* The title sponsor's name runs the length of every stand. */}
          <mesh position={[0, bottom + (tier.base - bottom) * 0.55, -inner + 0.4]}>
            <boxGeometry args={[length - 2, 1.9, 0.3]} />
            <meshStandardMaterial
              map={facade}
              emissive="#38bdf8"
              emissiveIntensity={0.35}
              roughness={0.35}
              metalness={0.2}
            />
          </mesh>
          <mesh position={[0, tier.base - 0.35, -inner + 0.45]}>
            <boxGeometry args={[length - 1, 0.5, 0.35]} />
            <meshStandardMaterial color="#dc2626" emissive="#dc2626" emissiveIntensity={0.6} />
          </mesh>
        </>
      )}
    </group>
  );
}

interface Palette {
  primary: string;
  accent: string;
}

/**
 * The crowd: one instanced mesh of a merged body-and-head blob covers every seat in the
 * ground, so a full house is still a single draw call. A slice of the instances is re-posed
 * each frame, which gives the stands a constant shuffle for almost nothing.
 */
function Crowd({ density }: { density: number }) {
  const ref = useRef<InstancedMesh>(null);
  const count = Math.max(600, Math.floor(24000 * density));

  const geometry = useMemo<BufferGeometry>(() => {
    const body = new BoxGeometry(0.42, 0.62, 0.34);
    body.translate(0, 0.31, 0);
    const head = new SphereGeometry(0.15, 6, 5);
    head.translate(0, 0.74, 0);
    const merged = mergeGeometries([body, head]);
    body.dispose();
    head.dispose();
    if (!merged) throw new Error('failed to merge crowd geometry');
    return merged;
  }, []);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);

  const seats = useMemo(() => {
    const rand = mulberry32(1337);
    const color = new Color();
    /*
     * A televised crowd reads as a dark, desaturated mass with occasional light flecks — not the
     * neon confetti this used to be. Mostly darks and greys, a few muted club colours.
     */
    /*
     * A home crowd: predominantly the home red in its many washed-out television shades, cut
     * with darks, greys and the odd away shirt. Still muted — a crowd is a mass, not confetti.
     */
    const palette = [
      '#7a1f28',
      '#8c2a32',
      '#5f181f',
      '#9c3a40',
      '#6e2229',
      '#4a151a',
      '#8d97a8',
      '#2b3444',
      '#141a24',
      '#a8494f',
      '#3a4354',
      '#7d8798',
      '#712028',
      '#1a222e',
      '#87333a',
      '#54408f',
    ];
    const list: { pos: [number, number, number]; rot: number; scale: number; rgb: Color }[] = [];
    for (let i = 0; i < count; i++) {
      const side = SIDES[Math.floor(rand() * SIDES.length)];
      const upper = rand() > 0.45;
      const tier = upper ? UPPER : LOWER;
      // Leave the TV gantry rows on the camera touchline clear of spectators.
      if (!upper && side.axis === 'z' && side.sign === CAMERA_SIDE_Z && rand() < 0.85) continue;
      const v = 0.04 + rand() * 0.92;
      const u = rand() * 2 - 1;
      const [x, y, z] = seatPosition(side, tier, u, v);
      list.push({
        pos: [x, y + 0.12, z],
        rot:
          side.axis === 'x'
            ? side.sign > 0
              ? -Math.PI / 2
              : Math.PI / 2
            : side.sign > 0
              ? Math.PI
              : 0,
        scale: 0.85 + rand() * 0.3,
        rgb: color.clone().set(palette[Math.floor(rand() * palette.length)]),
      });
    }
    return list;
  }, [count]);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const dummy = new Object3D();
    seats.forEach((seat, i) => {
      dummy.position.set(...seat.pos);
      dummy.rotation.set(0, seat.rot, 0);
      dummy.scale.setScalar(seat.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, seat.rgb);
    });
    mesh.count = seats.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [seats]);

  // A slow ripple through the stands: cheap, and it stops the crowd looking like cardboard.
  const scratch = useMemo(() => ({ matrix: new Matrix4(), dummy: new Object3D() }), []);
  useFrame((state) => {
    const mesh = ref.current;
    if (!mesh) return;
    const t = state.clock.elapsedTime;
    const stride = Math.max(1, Math.floor(seats.length / 240));
    const offset = Math.floor(t * 60) % stride;
    for (let i = offset; i < seats.length; i += stride) {
      const seat = seats[i];
      const sway = Math.sin(t * 1.7 + seat.pos[0] * 0.35 + seat.pos[2] * 0.2) * 0.06;
      scratch.dummy.position.set(seat.pos[0], seat.pos[1] + Math.abs(sway), seat.pos[2]);
      scratch.dummy.rotation.set(0, seat.rot + sway * 0.4, 0);
      scratch.dummy.scale.setScalar(seat.scale);
      scratch.dummy.updateMatrix();
      mesh.setMatrixAt(i, scratch.dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={ref}
      args={[geometry, undefined, count]}
      frustumCulled={false}
      castShadow={false}
    >
      <meshStandardMaterial roughness={0.95} />
    </instancedMesh>
  );
}

/** Perimeter LED hoardings; the artwork scrolls, which is the strongest broadcast cue there is. */
function Hoardings() {
  const texture = useMemo(() => hoardingTexture(), []);
  useFrame((_state, delta) => {
    texture.offset.x = (texture.offset.x + delta * 0.06) % 1;
  });

  const boards: { pos: [number, number, number]; rot: number; length: number }[] = [
    { pos: [0, 0.6, INNER_Z - 1.4], rot: 0, length: INNER_X * 2 },
    { pos: [0, 0.6, -(INNER_Z - 1.4)], rot: Math.PI, length: INNER_X * 2 },
    { pos: [INNER_X - 1.4, 0.6, 0], rot: -Math.PI / 2, length: INNER_Z * 2 },
    { pos: [-(INNER_X - 1.4), 0.6, 0], rot: Math.PI / 2, length: INNER_Z * 2 },
  ];

  return (
    <group>
      {boards.map((board, i) => (
        <mesh key={i} position={board.pos} rotation={[0, board.rot, 0]}>
          <boxGeometry args={[board.length, 1.15, 0.22]} />
          <meshStandardMaterial
            map={texture}
            emissiveMap={texture}
            emissive="#ffffff"
            emissiveIntensity={0.85}
            roughness={0.45}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
}

/** Cantilever roof with an exposed truss underside and a lit fascia. */
function Roof() {
  const outX = INNER_X + UPPER.depth + 3;
  const outZ = INNER_Z + UPPER.depth + 3;
  const depth = UPPER.depth + 6;
  return (
    <group>
      {SIDES.map((side) => {
        const long = side.axis === 'x' ? outZ * 2 + 6 : outX * 2 + 6;
        const out = side.axis === 'x' ? outX : outZ;
        const centre = (out - depth / 2) * side.sign;
        const pos: [number, number, number] =
          side.axis === 'x' ? [centre, ROOF_Y, 0] : [0, ROOF_Y, centre];
        const size: [number, number, number] =
          side.axis === 'x' ? [depth, 0.7, long] : [long, 0.7, depth];
        return (
          <group key={`${side.axis}${side.sign}`}>
            <mesh position={pos} castShadow={false}>
              <boxGeometry args={size} />
              <meshStandardMaterial color="#cbd5e1" roughness={0.65} metalness={0.25} />
            </mesh>
            {/* Trusses: a row of beams under the roof, catching the floodlights. */}
            {Array.from({ length: 9 }, (_, i) => {
              const t = (i / 8 - 0.5) * (long - 4);
              const beamPos: [number, number, number] =
                side.axis === 'x' ? [centre, ROOF_Y - 0.8, t] : [t, ROOF_Y - 0.8, centre];
              const beamSize: [number, number, number] =
                side.axis === 'x' ? [depth, 0.35, 0.35] : [0.35, 0.35, depth];
              return (
                <mesh key={i} position={beamPos}>
                  <boxGeometry args={beamSize} />
                  <meshStandardMaterial color="#94a3b8" roughness={0.5} metalness={0.5} />
                </mesh>
              );
            })}
          </group>
        );
      })}
    </group>
  );
}

/** Floodlight rigs on the roof corners: a lamp bank plus the glow it throws. */
function Floodlights({ intensity }: { intensity: number }) {
  const x = INNER_X + UPPER.depth;
  const z = INNER_Z + UPPER.depth;
  const corners: [number, number][] = [
    [x, z],
    [x, -z],
    [-x, z],
    [-x, -z],
  ];
  return (
    <group>
      {corners.map(([px, pz]) => (
        <group key={`${px},${pz}`} position={[px, ROOF_Y + 2.5, pz]}>
          <mesh>
            <boxGeometry args={[6, 2.6, 1.2]} />
            <meshStandardMaterial color="#334155" roughness={0.6} metalness={0.4} />
          </mesh>
          {Array.from({ length: 12 }, (_, i) => (
            <mesh
              key={i}
              position={[(i % 6) * 0.95 - 2.4, i < 6 ? 0.6 : -0.6, -0.7 * Math.sign(pz)]}
            >
              <boxGeometry args={[0.8, 0.9, 0.18]} />
              <meshBasicMaterial color="#fffbeb" toneMapped={false} />
            </mesh>
          ))}
          {intensity > 0 && (
            <pointLight intensity={intensity} distance={160} decay={1} color="#fff7e0" />
          )}
        </group>
      ))}
    </group>
  );
}

/** Team dugouts on the camera side: benches, roofs and a scattering of staff. */
function Dugouts() {
  const z = (INNER_Z - 3.2) * CAMERA_SIDE_Z;
  return (
    <group>
      {[-14, 14].map((x) => (
        <group key={x} position={[x, 0, z]}>
          <mesh position={[0, 1.1, 0]}>
            <boxGeometry args={[9, 2.2, 2.6]} />
            <meshStandardMaterial
              color="#0b1220"
              roughness={0.4}
              metalness={0.1}
              transparent
              opacity={0.85}
            />
          </mesh>
          <mesh position={[0, 2.35, 0]}>
            <boxGeometry args={[9.4, 0.25, 3]} />
            <meshStandardMaterial color="#1e293b" roughness={0.6} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Big screens above each end, showing nothing but a warm glow from this distance. */
function BigScreens() {
  return (
    <group>
      {[1, -1].map((s) => (
        <group key={s} position={[(INNER_X + UPPER.depth * 0.4) * s, ROOF_Y + 3.5, 0]}>
          <mesh rotation={[0, s > 0 ? -Math.PI / 2 : Math.PI / 2, 0]}>
            <planeGeometry args={[16, 9]} />
            <meshBasicMaterial color="#1e3a8a" toneMapped={false} />
          </mesh>
          <mesh>
            <boxGeometry args={[1.2, 9.6, 16.6]} />
            <meshStandardMaterial color="#0f172a" roughness={0.8} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

export function Stadium({
  crowdDensity,
  floodIntensity,
  seatPrimary,
  seatAccent,
}: {
  crowdDensity: number;
  floodIntensity: number;
  seatPrimary?: string;
  seatAccent?: string;
}) {
  // Seat mosaic in the home club's colours, with an Anfield-red fallback: a coloured bowl
  // with a pale band rather than anonymous navy.
  const palette: Palette = {
    primary: seatPrimary ?? '#a41220',
    accent: seatAccent ?? '#e7e0d0',
  };
  return (
    <group>
      <Hoardings />
      {SIDES.map((side) => {
        // The Kop: behind one goal, a single unbroken bank rather than two split decks, and
        // taller than everything else — the thing that stops the ground reading as generic.
        const kop = side.axis === 'x' && side.sign < 0;
        return (
          <group key={`${side.axis}${side.sign}`} scale={kop ? [1, 1.35, 1] : [1, 1, 1]}>
            <Deck side={side} tier={LOWER} {...palette} />
            <Deck side={side} tier={kop ? KOP_UPPER : UPPER} {...palette} />
          </group>
        );
      })}
      <Crowd density={crowdDensity} />
      <Dugouts />
      <Roof />
      <BigScreens />
      <Floodlights intensity={floodIntensity} />
    </group>
  );
}
