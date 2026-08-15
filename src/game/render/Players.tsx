import { useMemo } from 'react';
import { CapsuleCollider, RigidBody, type RapierRigidBody } from '@react-three/rapier';
import type { Group } from 'three';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../constants';
import { runtime, type PlayerRig } from '../runtime';
import type { SimPlayer, SimWorld } from '../sim/state';
import type { Kit } from '../types';
import { blobTexture, shirtTexture } from './textures';

const SKINS = ['#f0c8a0', '#e5b184', '#c98b5c', '#a3673d', '#7a4a28', '#4a2f1c'];
const HAIR = ['#1b1b1b', '#2f2113', '#5a3a1a', '#0f0f0f', '#8a6a3a', '#c2b280'];
const BOOT = ['#0f172a', '#f8fafc', '#f97316', '#22d3ee'];

/**
 * Deliberately low-poly, but proportioned and rigged: the limbs are separate meshes so the
 * simulation can swing them into a run cycle without any skinned-mesh cost. The kit itself is
 * a generated texture, which is what makes a numbered shirt readable from the broadcast camera.
 */
function PlayerBody({ player, kit, shadows }: { player: SimPlayer; kit: Kit; shadows: boolean }) {
  const isKeeper = player.role === 'GK';
  const accent = isKeeper ? '#111827' : kit.secondary;
  const shorts = isKeeper ? '#111827' : kit.shorts;
  const socks = isKeeper ? '#111827' : kit.primary;
  const seed = player.shirt * 7 + (player.side === 'home' ? 3 : 11);
  const skin = SKINS[seed % SKINS.length];
  const hair = HAIR[(player.shirt * 5) % HAIR.length];
  const boot = BOOT[(player.shirt * 3) % BOOT.length];
  const shirt = shirtTexture(kit, player.shirt, isKeeper);
  const blob = blobTexture();
  // Small build differences stop eleven identical mannequins reading as clones.
  const build = 0.95 + ((seed % 5) / 5) * 0.12;

  const rig: Partial<PlayerRig> = {};
  const commit = () => {
    if (
      rig.root &&
      rig.legL &&
      rig.legR &&
      rig.shinL &&
      rig.shinR &&
      rig.armL &&
      rig.armR &&
      rig.torso
    ) {
      runtime.visuals.set(player.id, rig as PlayerRig);
    }
  };

  return (
    <RigidBody
      type="kinematicPosition"
      colliders={false}
      position={[player.pos.x, 0, player.pos.z]}
      ref={(body: RapierRigidBody | null) => {
        if (body) runtime.bodies.set(player.id, body);
        else runtime.bodies.delete(player.id);
      }}
    >
      <CapsuleCollider
        args={[(PLAYER_HEIGHT - PLAYER_RADIUS * 2) / 2, PLAYER_RADIUS]}
        position={[0, PLAYER_HEIGHT / 2, 0]}
        friction={0.4}
        restitution={0.35}
      />
      <group
        ref={(group: Group | null) => {
          if (!group) {
            runtime.visuals.delete(player.id);
            return;
          }
          rig.root = group;
          commit();
        }}
        scale={[build, build, build]}
      >
        {/* Contact shadow: keeps players planted on the grass even with shadow maps off. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]}>
          <planeGeometry args={[1.15, 1.15]} />
          <meshBasicMaterial map={blob} transparent depthWrite={false} opacity={0.75} />
        </mesh>

        <mesh position={[0, 0.9, 0]} castShadow={shadows} scale={[1, 1, 0.8]}>
          <capsuleGeometry args={[0.165, 0.16, 4, 12]} />
          <meshStandardMaterial color={shorts} roughness={0.78} />
        </mesh>

        {/* Upper body pivots at the hips so the rig can lean, twist and dive. */}
        <group
          position={[0, 1.02, 0]}
          ref={(group: Group | null) => {
            if (group) {
              rig.torso = group;
              commit();
            }
          }}
        >
          {/* Elliptical cross-section: broad across the shoulders, shallow front to back. */}
          {/* A tapered trunk: narrower at the waist than the chest, shallow front to back. */}
          <mesh position={[0, 0.16, 0]} castShadow={shadows} scale={[1.12, 1, 0.68]}>
            <capsuleGeometry args={[0.175, 0.34, 6, 20]} />
            <meshStandardMaterial map={shirt} roughness={0.82} envMapIntensity={0.35} />
          </mesh>
          {/* Shoulders: a wider, flatter cap so the frame reads athletic rather than barrel. */}
          <mesh position={[0, 0.38, 0]} castShadow={shadows} scale={[1.35, 0.72, 0.72]}>
            <sphereGeometry args={[0.185, 16, 12]} />
            <meshStandardMaterial map={shirt} roughness={0.82} />
          </mesh>
          {/* A real neck, not a puck: taller and slimmer, so the head sits off the shoulders. */}
          <mesh position={[0, 0.5, 0]} castShadow={false}>
            <cylinderGeometry args={[0.052, 0.062, 0.14, 10]} />
            <meshStandardMaterial color={skin} roughness={0.85} />
          </mesh>
          {/* Head at ~0.23m: the old 0.28m ball made the figure six heads tall — a toy. */}
          <mesh position={[0, 0.63, 0.005]} castShadow={shadows} scale={[0.9, 1.12, 0.96]}>
            <sphereGeometry args={[0.108, 18, 16]} />
            <meshStandardMaterial color={skin} roughness={0.82} />
          </mesh>
          {/* Hair cap, tipped back off the forehead. */}
          <mesh position={[0, 0.655, -0.01]} rotation={[-0.25, 0, 0]} castShadow={false}>
            <sphereGeometry args={[0.112, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.62]} />
            <meshStandardMaterial color={hair} roughness={0.95} />
          </mesh>
          {/* Ears, just enough silhouette to break the bare sphere. */}
          {[-1, 1].map((s) => (
            <mesh key={s} position={[0.102 * s, 0.625, 0]} scale={[0.5, 1, 0.7]}>
              <sphereGeometry args={[0.026, 8, 8]} />
              <meshStandardMaterial color={skin} roughness={0.85} />
            </mesh>
          ))}
        </group>

        {(
          [
            ['legL', -0.105],
            ['legR', 0.105],
          ] as const
        ).map(([key, x]) => (
          <group
            key={key}
            position={[x, 0.88, 0]}
            ref={(group: Group | null) => {
              if (group) {
                rig[key] = group;
                commit();
              }
            }}
          >
            <mesh position={[0, -0.16, 0]} castShadow={shadows}>
              <capsuleGeometry args={[0.074, 0.2, 4, 10]} />
              <meshStandardMaterial color={shorts} roughness={0.78} />
            </mesh>
            <mesh position={[0, -0.38, 0]} castShadow={shadows}>
              <capsuleGeometry args={[0.06, 0.2, 4, 10]} />
              <meshStandardMaterial color={skin} roughness={0.88} />
            </mesh>
            {/* Knee, so the thigh and shin do not read as one straight stick. */}
            <mesh position={[0, -0.5, 0]}>
              <sphereGeometry args={[0.058, 10, 8]} />
              <meshStandardMaterial color={skin} roughness={0.88} />
            </mesh>
            {/* Everything below the knee folds through the stride on its own pivot. */}
            <group
              position={[0, -0.5, 0]}
              ref={(group: Group | null) => {
                if (group) {
                  rig[key === 'legL' ? 'shinL' : 'shinR'] = group;
                  commit();
                }
              }}
            >
              <mesh position={[0, -0.16, 0]} castShadow={shadows}>
                <capsuleGeometry args={[0.054, 0.18, 4, 10]} />
                <meshStandardMaterial color={socks} roughness={0.92} />
              </mesh>
              <mesh position={[0, -0.33, 0.05]} rotation={[0.08, 0, 0]} castShadow={shadows}>
                <boxGeometry args={[0.095, 0.07, 0.26]} />
                <meshStandardMaterial color={boot} roughness={0.35} metalness={0.12} />
              </mesh>
            </group>
          </group>
        ))}

        {(
          [
            ['armL', -0.27],
            ['armR', 0.27],
          ] as const
        ).map(([key, x]) => (
          <group
            key={key}
            position={[x, 1.42, 0]}
            ref={(group: Group | null) => {
              if (group) {
                rig[key] = group;
                commit();
              }
            }}
          >
            <mesh position={[0, -0.13, 0]} castShadow={shadows}>
              <capsuleGeometry args={[0.052, 0.16, 4, 10]} />
              <meshStandardMaterial color={accent} roughness={0.82} />
            </mesh>
            {/* Forearm carried bent at the elbow, the way anyone who has ever run carries it. */}
            <group position={[0, -0.24, 0]} rotation={[-1.05, 0, 0]}>
              <mesh position={[0, -0.1, 0]} castShadow={shadows}>
                <capsuleGeometry args={[0.042, 0.15, 4, 10]} />
                <meshStandardMaterial color={isKeeper ? accent : skin} roughness={0.88} />
              </mesh>
              {/* Keepers get gloves; everyone else gets a hand. */}
              <mesh position={[0, -0.22, 0]} scale={isKeeper ? [1.5, 1.3, 1] : [1, 1, 1]}>
                <sphereGeometry args={[0.045, 10, 8]} />
                <meshStandardMaterial color={isKeeper ? '#f8fafc' : skin} roughness={0.75} />
              </mesh>
            </group>
          </group>
        ))}
      </group>
    </RigidBody>
  );
}

/** Perceptual-ish distance between two hex colours, 0-1. */
function colourGap(a: string, b: string): number {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  // Green is weighted hardest because that is what the eye resolves best at distance.
  return Math.sqrt(0.3 * (ar - br) ** 2 + 0.59 * (ag - bg) ** 2 + 0.11 * (ab - bb) ** 2);
}

/**
 * Real football plays a change strip when the colours clash. Arsenal against Liverpool put
 * twenty-two men in red on the pitch and the match was unreadable, so the away side switches to
 * its secondary colour when the two primaries are too close together.
 */
function changeIfClashing(home: Kit, away: Kit): Kit {
  if (colourGap(home.primary, away.primary) > 0.22) return away;
  const swapped: Kit = {
    ...away,
    primary: away.secondary,
    secondary: away.primary,
    shorts: away.secondary,
    pattern: away.pattern === 'stripes' ? 'stripes' : 'plain',
  };
  // If the change strip clashes too, fall back to something that never does.
  if (colourGap(home.primary, swapped.primary) > 0.22) return swapped;
  return { ...swapped, primary: '#f1f5f9', secondary: '#0f172a', shorts: '#0f172a' };
}

export function Players({ world, shadows }: { world: SimWorld; shadows: boolean }) {
  const kits = useMemo(() => {
    const home = world.config.homeTeam.kit;
    const away = world.config.awayTeam.kit;
    return { home, away: changeIfClashing(home, away) };
  }, [world.config.homeTeam.kit, world.config.awayTeam.kit]);
  return (
    <>
      {world.players.map((player) => (
        <PlayerBody key={player.id} player={player} kit={kits[player.side]} shadows={shadows} />
      ))}
      {/* Broadcast-style indicator: ring on the grass plus a chevron over the player. */}
      <group
        ref={(group) => {
          runtime.indicator = group;
        }}
      >
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
          <ringGeometry args={[0.5, 0.72, 32]} />
          <meshBasicMaterial color="#facc15" transparent opacity={0.9} depthWrite={false} />
        </mesh>
        <mesh rotation={[Math.PI, 0, 0]} position={[0, 2.25, 0]}>
          <coneGeometry args={[0.16, 0.3, 4]} />
          <meshBasicMaterial color="#facc15" transparent opacity={0.95} depthWrite={false} />
        </mesh>
      </group>

      {/* Set-piece aim arrow: shown on the grass at the ball while a restart is being taken. */}
      <group
        visible={false}
        ref={(group) => {
          runtime.aim = group;
        }}
      >
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 1.6]}>
          <planeGeometry args={[0.45, 3]} />
          <meshBasicMaterial color="#38bdf8" transparent opacity={0.6} depthWrite={false} />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 3.5]}>
          <circleGeometry args={[0.55, 3]} />
          <meshBasicMaterial color="#38bdf8" transparent opacity={0.85} depthWrite={false} />
        </mesh>
      </group>
    </>
  );
}
