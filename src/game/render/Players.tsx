import { CapsuleCollider, RigidBody, type RapierRigidBody } from '@react-three/rapier';
import type { Group } from 'three';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../constants';
import { runtime } from '../runtime';
import type { SimPlayer, SimWorld } from '../sim/state';
import type { Kit } from '../types';

const SKIN = '#c68642';

function PlayerBody({ player, kit, shadows }: { player: SimPlayer; kit: Kit; shadows: boolean }) {
  const isKeeper = player.role === 'GK';
  const shirt = isKeeper ? kit.keeper : kit.primary;
  const shorts = isKeeper ? '#1f2937' : kit.shorts;

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
          if (group) runtime.visuals.set(player.id, group);
          else runtime.visuals.delete(player.id);
        }}
      >
        <mesh position={[0, 1.18, 0]} castShadow={shadows}>
          <capsuleGeometry args={[0.26, 0.5, 4, 10]} />
          <meshStandardMaterial color={shirt} roughness={0.75} />
        </mesh>
        <mesh position={[0, 0.78, 0]} castShadow={shadows}>
          <boxGeometry args={[0.44, 0.3, 0.3]} />
          <meshStandardMaterial color={shorts} roughness={0.85} />
        </mesh>
        {[-0.12, 0.12].map((x) => (
          <mesh key={x} position={[x, 0.33, 0]} castShadow={shadows}>
            <boxGeometry args={[0.16, 0.66, 0.16]} />
            <meshStandardMaterial color={SKIN} roughness={0.9} />
          </mesh>
        ))}
        {[-0.34, 0.34].map((x) => (
          <mesh key={x} position={[x, 1.14, 0]} castShadow={shadows}>
            <boxGeometry args={[0.13, 0.5, 0.13]} />
            <meshStandardMaterial color={isKeeper ? kit.keeper : kit.secondary} roughness={0.9} />
          </mesh>
        ))}
        <mesh position={[0, 1.62, 0]} castShadow={shadows}>
          <sphereGeometry args={[0.16, 14, 10]} />
          <meshStandardMaterial color={SKIN} roughness={0.85} />
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
      <mesh
        ref={(mesh) => {
          runtime.indicator = mesh;
        }}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.03, 0]}
      >
        <ringGeometry args={[0.52, 0.72, 28]} />
        <meshBasicMaterial color="#facc15" transparent opacity={0.85} depthWrite={false} />
      </mesh>
    </>
  );
}
