import { BallCollider, RigidBody, type RapierRigidBody } from '@react-three/rapier';
import { BALL_MASS, BALL_RADIUS } from '../constants';
import { runtime } from '../runtime';
import { ballTexture } from './textures';

export function Ball({ shadows }: { shadows: boolean }) {
  const texture = ballTexture();

  return (
    <RigidBody
      ref={(body: RapierRigidBody | null) => {
        runtime.ball = body;
      }}
      colliders={false}
      position={[0, BALL_RADIUS, 0]}
      linearDamping={0.32}
      angularDamping={0.7}
      canSleep={false}
      ccd
    >
      <BallCollider args={[BALL_RADIUS]} mass={BALL_MASS} restitution={0.62} friction={0.6} />
      <mesh castShadow={shadows}>
        <sphereGeometry args={[BALL_RADIUS, 32, 24]} />
        {/* A match ball is lacquered: a clear coat over the panels gives it the TV highlight. */}
        <meshPhysicalMaterial
          map={texture}
          roughness={0.35}
          metalness={0}
          clearcoat={0.85}
          clearcoatRoughness={0.22}
          envMapIntensity={1.1}
        />
      </mesh>
    </RigidBody>
  );
}
