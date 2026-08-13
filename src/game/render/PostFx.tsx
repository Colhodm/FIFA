import { Bloom, EffectComposer, N8AO, SMAA, Vignette } from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import type { QualityTier } from '../perf/quality';

/**
 * The broadcast grade: contact occlusion under the players, a gentle bloom on the floodlights
 * and hoardings, edge antialiasing and a soft vignette. Everything here is optional — the two
 * lowest tiers render straight to the screen instead.
 */
export function PostFx({ tier }: { tier: QualityTier }) {
  if (!tier.postFx) return null;
  return (
    <EffectComposer multisampling={0} enableNormalPass={tier.ambientOcclusion}>
      {tier.ambientOcclusion ? (
        <N8AO aoRadius={1.6} intensity={2.2} distanceFalloff={0.7} quality="low" halfRes />
      ) : (
        <></>
      )}
      {/* Threshold high enough that only the LEDs and the floodlights bloom, not the paint. */}
      <Bloom
        intensity={0.4}
        luminanceThreshold={0.92}
        luminanceSmoothing={0.2}
        mipmapBlur
        radius={0.55}
      />
      <SMAA />
      <Vignette offset={0.28} darkness={0.42} blendFunction={BlendFunction.NORMAL} />
    </EffectComposer>
  );
}
