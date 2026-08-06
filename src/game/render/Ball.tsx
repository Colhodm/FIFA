import { useEffect, useMemo } from 'react';
import { BallCollider, RigidBody, type RapierRigidBody } from '@react-three/rapier';
import { CanvasTexture, SRGBColorSpace } from 'three';
import { BALL_MASS, BALL_RADIUS } from '../constants';
import { runtime } from '../runtime';

function createBallTexture(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size / 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111827';
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 6; col++) {
      const x = (col + (row % 2) * 0.5) * (size / 6);
      const y = 20 + row * 45;
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        const r = 13;
        const px = x + Math.cos(a) * r;
        const py = y + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export function Ball({ shadows }: { shadows: boolean }) {
  const texture = useMemo(() => createBallTexture(), []);
  useEffect(() => () => texture.dispose(), [texture]);

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
        <sphereGeometry args={[BALL_RADIUS, 24, 16]} />
        <meshStandardMaterial map={texture} roughness={0.42} metalness={0.02} />
      </mesh>
    </RigidBody>
  );
}
