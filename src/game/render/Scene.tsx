import { Canvas } from '@react-three/fiber';
import { Sky } from '@react-three/drei';
import { Physics } from '@react-three/rapier';
import { TICK_DT } from '../constants';
import type { SimWorld } from '../sim/state';
import { useGameStore } from '../store';
import { Ball } from './Ball';
import { ChaseCamera } from './ChaseCamera';
import { Goals } from './Goals';
import { Pitch } from './Pitch';
import { Players } from './Players';
import { Simulation } from './Simulation';
import { Stadium } from './Stadium';

export function Scene({ world }: { world: SimWorld }) {
  const tier = useGameStore((s) => s.tier);
  const paused = useGameStore((s) => s.paused);

  return (
    <Canvas
      shadows={tier.shadows}
      dpr={tier.dpr}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      camera={{ position: [0, 26, -46], fov: 55, near: 0.4, far: 600 }}
    >
      <color attach="background" args={['#9ec6e8']} />
      <fog attach="fog" args={['#b7d3ea', 140, 420]} />
      <Sky sunPosition={[60, 40, -30]} turbidity={6} rayleigh={1.2} />

      <hemisphereLight args={['#dbeafe', '#2a4a20', 1.1]} />
      <directionalLight
        key={`${tier.shadowMapSize}-${tier.shadows}`}
        position={[55, 70, -30]}
        intensity={2.2}
        castShadow={tier.shadows}
        shadow-mapSize={[tier.shadowMapSize, tier.shadowMapSize]}
        shadow-bias={-0.0006}
        shadow-camera-left={-80}
        shadow-camera-right={80}
        shadow-camera-top={60}
        shadow-camera-bottom={-60}
        shadow-camera-far={220}
      />

      <Physics timeStep={TICK_DT} paused={paused} gravity={[0, -9.81, 0]}>
        <Pitch shadows={tier.shadows} />
        <Goals shadows={tier.shadows} />
        <Ball shadows={tier.shadows} />
        <Players world={world} shadows={tier.shadows} />
        <Simulation world={world} />
      </Physics>

      <Stadium crowdDensity={tier.crowdDensity} />
      <ChaseCamera />
    </Canvas>
  );
}
