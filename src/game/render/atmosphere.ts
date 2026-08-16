import type { TimeOfDay, Weather } from '../types';

/** Everything the scene needs to dress the ground for a kick-off time and sky. */
export interface Atmosphere {
  background: string;
  fog: { color: string; near: number; far: number };
  /** Sun position fed to drei's Sky; below the horizon at night. */
  sunPosition: [number, number, number];
  sunColor: string;
  sunIntensity: number;
  hemiSky: string;
  hemiIntensity: number;
  /** Corner floodlight point lights. Off in the afternoon, carrying the scene at night. */
  floodIntensity: number;
  /** Wet grass is darker and far glossier than dry. */
  wet: boolean;
}

const PRESETS: Record<TimeOfDay, Atmosphere> = {
  day: {
    background: '#9ec6e8',
    fog: { color: '#c3d9ec', near: 200, far: 620 },
    sunPosition: [60, 40, -30],
    sunColor: '#fff4e0',
    sunIntensity: 2.1,
    hemiSky: '#dbeafe',
    hemiIntensity: 0.55,
    floodIntensity: 0,
    wet: false,
  },
  evening: {
    background: '#e8a97a',
    fog: { color: '#e0af85', near: 180, far: 560 },
    sunPosition: [60, 7, -30],
    sunColor: '#ffc27d',
    sunIntensity: 1.5,
    hemiSky: '#f3c9a4',
    hemiIntensity: 0.4,
    floodIntensity: 60,
    wet: false,
  },
  night: {
    background: '#0b1526',
    fog: { color: '#101c30', near: 160, far: 520 },
    sunPosition: [60, -6, -30],
    sunColor: '#e8eefc',
    sunIntensity: 1.6,
    hemiSky: '#3a4a66',
    hemiIntensity: 0.5,
    floodIntensity: 140,
    wet: false,
  },
};

export function atmosphere(timeOfDay: TimeOfDay, weather: Weather): Atmosphere {
  const base = PRESETS[timeOfDay];
  if (weather !== 'rain') return base;
  // Rain: the sky closes in, the light goes flat and the grass turns to glass.
  return {
    ...base,
    background: mix(base.background, '#6b7686', 0.55),
    fog: { color: mix(base.fog.color, '#77828f', 0.55), near: 90, far: 380 },
    sunIntensity: base.sunIntensity * 0.55,
    hemiIntensity: base.hemiIntensity * 0.85,
    floodIntensity: Math.max(base.floodIntensity, 30),
    wet: true,
  };
}

/** Linear blend of two hex colours, enough for tinting presets. */
function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => {
    const va = (pa >> shift) & 0xff;
    const vb = (pb >> shift) & 0xff;
    return Math.round(va + (vb - va) * t);
  };
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}
