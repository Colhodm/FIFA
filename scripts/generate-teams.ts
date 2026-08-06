/**
 * Regenerates public/data/teams.json. Placeholder content only — fictional clubs and players,
 * deterministic so re-running produces no diff. Replace with a licensed data import when rights land.
 *
 *   npx tsx scripts/generate-teams.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORMATIONS } from '../src/game/formations';
import type { FormationId, PlayerData, TeamData, TeamsFile } from '../src/game/types';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = [
  'Milo',
  'Kai',
  'Ravi',
  'Tomas',
  'Iker',
  'Noel',
  'Dario',
  'Emeka',
  'Luka',
  'Yuto',
  'Ander',
  'Silas',
  'Rafa',
  'Mateo',
  'Idris',
  'Nils',
  'Cato',
  'Jonas',
  'Amir',
  'Bruno',
  'Ozzy',
  'Feli',
];
const LAST = [
  'Vance',
  'Okoro',
  'Marek',
  'Duarte',
  'Halden',
  'Rios',
  'Nakai',
  'Serra',
  'Bellamy',
  'Osei',
  'Kovac',
  'Lindqvist',
  'Alvi',
  'Renard',
  'Tobin',
  'Farrow',
  'Sandoval',
  'Mbeki',
  'Ilic',
  'Quinn',
  'Brant',
  'Esposito',
];

interface TeamSpec {
  id: string;
  name: string;
  shortName: string;
  formation: FormationId;
  kit: TeamData['kit'];
  /** Overall quality 60-90; drives the stat spread. */
  rating: number;
  seed: number;
}

const SPECS: TeamSpec[] = [
  {
    id: 'azure-rovers',
    name: 'Azure Rovers',
    shortName: 'AZR',
    formation: '4-3-3',
    kit: { primary: '#2563eb', secondary: '#f8fafc', shorts: '#1e3a8a', keeper: '#facc15' },
    rating: 84,
    seed: 11,
  },
  {
    id: 'crimson-united',
    name: 'Crimson United',
    shortName: 'CRU',
    formation: '4-4-2',
    kit: { primary: '#dc2626', secondary: '#fef2f2', shorts: '#7f1d1d', keeper: '#22c55e' },
    rating: 82,
    seed: 22,
  },
  {
    id: 'verdant-city',
    name: 'Verdant City',
    shortName: 'VER',
    formation: '3-5-2',
    kit: { primary: '#059669', secondary: '#ecfdf5', shorts: '#064e3b', keeper: '#f97316' },
    rating: 79,
    seed: 33,
  },
  {
    id: 'solar-athletic',
    name: 'Solar Athletic',
    shortName: 'SOL',
    formation: '5-3-2',
    kit: { primary: '#f59e0b', secondary: '#1f2937', shorts: '#1f2937', keeper: '#8b5cf6' },
    rating: 76,
    seed: 44,
  },
  {
    id: 'harbour-metro',
    name: 'Harbour Metro',
    shortName: 'HBM',
    formation: '4-3-3',
    kit: { primary: '#0f172a', secondary: '#38bdf8', shorts: '#0f172a', keeper: '#f43f5e' },
    rating: 80,
    seed: 55,
  },
  {
    id: 'northgate-albion',
    name: 'Northgate Albion',
    shortName: 'NGA',
    formation: '4-4-2',
    kit: { primary: '#f8fafc', secondary: '#7c3aed', shorts: '#7c3aed', keeper: '#14b8a6' },
    rating: 74,
    seed: 66,
  },
];

function buildTeam(spec: TeamSpec): TeamData {
  const rand = mulberry32(spec.seed);
  const slots = FORMATIONS[spec.formation].slots;
  const players: PlayerData[] = slots.map((slot, i) => {
    const jitter = (spread: number) => Math.round((rand() - 0.5) * spread);
    const base = spec.rating + jitter(10);
    const bias = { GK: 0, DF: 0, MF: 0, FW: 0 } as Record<string, number>;
    bias[slot.role] = 4;
    return {
      name: `${FIRST[(spec.seed + i * 7) % FIRST.length]} ${LAST[(spec.seed * 3 + i * 5) % LAST.length]}`,
      shirt: i + 1,
      role: slot.role,
      stats: {
        pace: clamp(base + (slot.role === 'GK' ? -12 : slot.role === 'FW' ? 6 : 0) + jitter(8)),
        passing: clamp(base + (slot.role === 'MF' ? 6 : 0) + jitter(8)),
        shooting: clamp(
          base + (slot.role === 'FW' ? 8 : slot.role === 'GK' ? -25 : -4) + jitter(8),
        ),
        defending: clamp(
          base + (slot.role === 'DF' ? 8 : slot.role === 'FW' ? -14 : 0) + jitter(8),
        ),
        stamina: clamp(base + bias[slot.role] + jitter(8)),
      },
    };
  });
  return {
    id: spec.id,
    name: spec.name,
    shortName: spec.shortName,
    formation: spec.formation,
    kit: spec.kit,
    players,
  };
}

const clamp = (v: number) => Math.max(45, Math.min(95, Math.round(v)));

const file: TeamsFile = { teams: SPECS.map(buildTeam) };
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data/teams.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
console.log(`wrote ${out} (${file.teams.length} teams)`);
