import { Canvas } from '@react-three/fiber';
import { Environment, Lightformer, Sky } from '@react-three/drei';
import { Physics } from '@react-three/rapier';
import { ACESFilmicToneMapping, PCFSoftShadowMap } from 'three';
import { TICK_DT } from '../constants';
import type { SimWorld } from '../sim/state';
import { useGameStore } from '../store';
import { Ball } from './Ball';
import { DebugGizmos } from './DebugGizmos';
import { MatchCamera } from './MatchCamera';
import { Goals } from './Goals';
import { Pitch } from './Pitch';
import { Players } from './Players';
import { PostFx } from './PostFx';
import { Simulation } from './Simulation';
import { Stadium } from './Stadium';

export function Scene({ world }: { world: SimWorld }) {
  const tier = useGameStore((s) => s.tier);
  const paused = useGameStore((s) => s.paused);
  const camera = useGameStore((s) => s.camera);
  const debug = useGameStore((s) => s.debug);

  return (
    <Canvas
      shadows={tier.shadows ? 'soft' : false}
      dpr={tier.dpr}
      gl={{ antialias: !tier.postFx, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => {
        // Filmic response keeps the floodlit whites and kit colours from clipping.
        gl.toneMapping = ACESFilmicToneMapping;
        gl.toneMappingExposure = 0.95;
        gl.shadowMap.type = PCFSoftShadowMap;
      }}
      camera={{ position: [0, 26, -46], fov: 50, near: 0.4, far: 700 }}
    >
      <color attach="background" args={['#9ec6e8']} />
      <fog attach="fog" args={['#c3d9ec', 200, 620]} />
      <Sky sunPosition={[60, 40, -30]} turbidity={4} rayleigh={0.9} mieCoefficient={0.006} />

      {/*
        A hand-built environment map: sky dome, warm sun card and four floodlight cards.
        It is what gives the kits, the ball's lacquer and the roof steel something to reflect,
        and it costs one small render instead of a downloaded HDRI.
      */}
      <Environment resolution={tier.envResolution} frames={1}>
        <Lightformer
          intensity={1.1}
          color="#cfe4ff"
          position={[0, 12, 0]}
          scale={[40, 40, 1]}
          rotation-x={Math.PI / 2}
        />
        <Lightformer intensity={3.4} color="#fff2d8" position={[8, 9, -6]} scale={[9, 9, 1]} />
        <Lightformer intensity={1.5} color="#ffffff" position={[-9, 8, 6]} scale={[7, 7, 1]} />
        <Lightformer
          intensity={0.7}
          color="#26451f"
          position={[0, -6, 0]}
          scale={[40, 40, 1]}
          rotation-x={-Math.PI / 2}
        />
      </Environment>

      <hemisphereLight args={['#dbeafe', '#274d21', 0.55]} />
      <directionalLight
        key={`${tier.shadowMapSize}-${tier.shadows}`}
        position={[48, 62, -34]}
        intensity={2.1}
        color="#fff4e0"
        castShadow={tier.shadows}
        shadow-mapSize={[tier.shadowMapSize, tier.shadowMapSize]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-radius={3}
        // Tight around the playing surface: every shadow texel is spent on the pitch.
        shadow-camera-left={-72}
        shadow-camera-right={72}
        shadow-camera-top={48}
        shadow-camera-bottom={-48}
        shadow-camera-near={20}
        shadow-camera-far={200}
      />
      {/* Cool bounce from the opposite stand, so shadowed sides are not solid black. */}
      <directionalLight position={[-40, 30, 40]} intensity={0.5} color="#bfd8ff" />

      <Physics timeStep={TICK_DT} paused={paused} gravity={[0, -9.81, 0]}>
        <Pitch shadows={tier.shadows} />
        <Goals shadows={tier.shadows} />
        <Ball shadows={tier.shadows} />
        <Players world={world} shadows={tier.shadows} />
        <Simulation world={world} />
        {import.meta.env.DEV && debug && <DebugGizmos world={world} />}
      </Physics>

      <Stadium crowdDensity={tier.crowdDensity} />
      <MatchCamera mode={camera} />
      <PostFx tier={tier} />
    </Canvas>
  );
}
