import { CapsuleCollider, RigidBody, type RapierRigidBody } from '@react-three/rapier';
import type { Group } from 'three';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../constants';
import { runtime, type PlayerRig } from '../runtime';
import type { SimPlayer, SimWorld } from '../sim/state';
import type { Kit } from '../types';

const SKINS = ['#f0c8a0', '#d9a066', '#a3673d', '#6f4324', '#3f2a1c'];
const HAIR = ['#1b1b1b', '#2f2113', '#5a3a1a', '#0f0f0f', '#8a6a3a'];
const BOOT = '#111827';

/**
 * Deliberately low-poly, but proportioned and rigged: the limbs are separate meshes so the
 * simulation can swing them into a run cycle without any skinned-mesh cost.
 */
function PlayerBody({ player, kit, shadows }: { player: SimPlayer; kit: Kit; shadows: boolean }) {
  const isKeeper = player.role === 'GK';
  const shirt = isKeeper ? kit.keeper : kit.primary;
  const sleeve = isKeeper ? kit.keeper : kit.secondary;
  const shorts = isKeeper ? '#1f2937' : kit.shorts;
  const socks = isKeeper ? '#1f2937' : kit.primary;
  const skin = SKINS[(player.shirt * 7 + player.side.length) % SKINS.length];
  const hair = HAIR[(player.shirt * 5) % HAIR.length];

  const rig: Partial<PlayerRig> = {};
  const commit = () => {
    if (rig.root && rig.legL && rig.legR && rig.armL && rig.armR) {
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
      >
        {/* torso */}
        <mesh position={[0, 1.14, 0]} castShadow={shadows}>
          <capsuleGeometry args={[0.23, 0.42, 4, 12]} />
          <meshStandardMaterial color={shirt} roughness={0.7} />
        </mesh>
        {/* Chest band in the change colour: reads as a kit design from the broadcast camera. */}
        <mesh position={[0, 1.16, 0]} castShadow={shadows}>
          <cylinderGeometry args={[0.234, 0.234, 0.1, 12, 1, true]} />
          <meshStandardMaterial color={sleeve} roughness={0.7} />
        </mesh>
        <mesh position={[0, 0.84, 0]} castShadow={shadows}>
          <boxGeometry args={[0.42, 0.28, 0.28]} />
          <meshStandardMaterial color={shorts} roughness={0.85} />
        </mesh>

        {(
          [
            ['legL', -0.11],
            ['legR', 0.11],
          ] as const
        ).map(([key, x]) => (
          <group
            key={key}
            position={[x, 0.72, 0]}
            ref={(group: Group | null) => {
              if (group) {
                rig[key] = group;
                commit();
              }
            }}
          >
            <mesh position={[0, -0.2, 0]} castShadow={shadows}>
              <capsuleGeometry args={[0.075, 0.24, 3, 8]} />
              <meshStandardMaterial color={skin} roughness={0.9} />
            </mesh>
            <mesh position={[0, -0.5, 0]} castShadow={shadows}>
              <capsuleGeometry args={[0.07, 0.16, 3, 8]} />
              <meshStandardMaterial color={socks} roughness={0.95} />
            </mesh>
            <mesh position={[0, -0.66, 0.04]} castShadow={shadows}>
              <boxGeometry args={[0.13, 0.09, 0.24]} />
              <meshStandardMaterial color={BOOT} roughness={0.5} />
            </mesh>
          </group>
        ))}

        {(
          [
            ['armL', -0.29],
            ['armR', 0.29],
          ] as const
        ).map(([key, x]) => (
          <group
            key={key}
            position={[x, 1.34, 0]}
            ref={(group: Group | null) => {
              if (group) {
                rig[key] = group;
                commit();
              }
            }}
          >
            <mesh position={[0, -0.14, 0]} castShadow={shadows}>
              <capsuleGeometry args={[0.06, 0.14, 3, 8]} />
              <meshStandardMaterial color={sleeve} roughness={0.8} />
            </mesh>
            <mesh position={[0, -0.36, 0]} castShadow={shadows}>
              <capsuleGeometry args={[0.055, 0.16, 3, 8]} />
              <meshStandardMaterial color={skin} roughness={0.9} />
            </mesh>
          </group>
        ))}

        <mesh position={[0, 1.58, 0]} castShadow={shadows}>
          <sphereGeometry args={[0.145, 14, 12]} />
          <meshStandardMaterial color={skin} roughness={0.85} />
        </mesh>
        <mesh position={[0, 1.63, -0.01]} castShadow={shadows}>
          <sphereGeometry args={[0.148, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.55]} />
          <meshStandardMaterial color={hair} roughness={0.95} />
        </mesh>
      </group>
    </RigidBody>
  );
}

export function Players({ world, shadows }: { world: SimWorld; shadows: boolean }) {
  const kits = { home: world.config.homeTeam.kit, away: world.config.awayTeam.kit };
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
    </>
  );
}
