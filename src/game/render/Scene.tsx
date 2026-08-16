import { Canvas } from '@react-three/fiber';
import { Environment, Lightformer, Sky } from '@react-three/drei';
import { Physics } from '@react-three/rapier';
import { ACESFilmicToneMapping, PCFSoftShadowMap } from 'three';
import { PHYSICS_DT } from '../constants';
import type { SimWorld } from '../sim/state';
import { useGameStore } from '../store';
import { atmosphere } from './atmosphere';
import { Rain } from './Rain';
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
  const timeOfDay = useGameStore((s) => s.setup.timeOfDay);
  const weather = useGameStore((s) => s.setup.weather);
  const atmos = atmosphere(timeOfDay, weather);

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
      <color attach="background" args={[atmos.background]} />
      <fog attach="fog" args={[atmos.fog.color, atmos.fog.near, atmos.fog.far]} />
      <Sky
        sunPosition={atmos.sunPosition}
        turbidity={weather === 'rain' ? 12 : 4}
        rayleigh={timeOfDay === 'evening' ? 2.4 : 0.9}
        mieCoefficient={0.006}
      />

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

      <hemisphereLight args={[atmos.hemiSky, '#274d21', atmos.hemiIntensity]} />
      <directionalLight
        key={`${tier.shadowMapSize}-${tier.shadows}`}
        // The night "sun" is the combined glare of the floodlight banks, so it stays overhead.
        position={
          timeOfDay === 'day'
            ? [48, 62, -34]
            : timeOfDay === 'evening'
              ? [60, 26, -34]
              : [10, 70, -20]
        }
        intensity={atmos.sunIntensity}
        color={atmos.sunColor}
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

      <Physics timeStep={PHYSICS_DT} interpolate paused={paused} gravity={[0, -9.81, 0]}>
        <Pitch shadows={tier.shadows} wet={atmos.wet} />
        <Goals shadows={tier.shadows} />
        <Ball shadows={tier.shadows} />
        <Players world={world} shadows={tier.shadows} />
        <Simulation world={world} />
        {import.meta.env.DEV && debug && <DebugGizmos world={world} />}
      </Physics>

      <Stadium crowdDensity={tier.crowdDensity} floodIntensity={atmos.floodIntensity} />
      {weather === 'rain' && <Rain />}
      <MatchCamera mode={camera} />
      <PostFx tier={tier} />
    </Canvas>
  );
}
