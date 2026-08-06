import { Canvas } from '@react-three/fiber';
import { Sky } from '@react-three/drei';
import { Physics } from '@react-three/rapier';
import { ACESFilmicToneMapping } from 'three';
import { TICK_DT } from '../constants';
import type { SimWorld } from '../sim/state';
import { useGameStore } from '../store';
import { Ball } from './Ball';
import { MatchCamera } from './MatchCamera';
import { Goals } from './Goals';
import { Pitch } from './Pitch';
import { Players } from './Players';
import { Simulation } from './Simulation';
import { Stadium } from './Stadium';

export function Scene({ world }: { world: SimWorld }) {
  const tier = useGameStore((s) => s.tier);
  const paused = useGameStore((s) => s.paused);
  const camera = useGameStore((s) => s.camera);

  return (
    <Canvas
      shadows={tier.shadows}
      dpr={tier.dpr}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => {
        // Filmic response keeps the floodlit whites and kit colours from clipping.
        gl.toneMapping = ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.05;
      }}
      camera={{ position: [0, 26, -46], fov: 55, near: 0.4, far: 600 }}
    >
      <color attach="background" args={['#9ec6e8']} />
      <fog attach="fog" args={['#b7d3ea', 160, 460]} />
      <Sky sunPosition={[60, 40, -30]} turbidity={5} rayleigh={1.1} />

      <hemisphereLight args={['#e8f1ff', '#2b4a24', 1.0]} />
      <directionalLight
        key={`${tier.shadowMapSize}-${tier.shadows}`}
        position={[55, 70, -30]}
        intensity={2.1}
        color="#fff6e5"
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
      <MatchCamera mode={camera} />
    </Canvas>
  );
}
