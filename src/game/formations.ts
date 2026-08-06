import type { Formation, FormationId } from './types';

const line = (role: Formation['slots'][number]['role'], x: number, zs: number[]) =>
  zs.map((z) => ({ role, x, z }));

export const FORMATIONS: Record<FormationId, Formation> = {
  '4-4-2': {
    id: '4-4-2',
    name: '4-4-2 Classic',
    slots: [
      { role: 'GK', x: 0.03, z: 0 },
      ...line('DF', 0.22, [-0.3, -0.1, 0.1, 0.3]),
      ...line('MF', 0.46, [-0.32, -0.11, 0.11, 0.32]),
      ...line('FW', 0.68, [-0.12, 0.12]),
    ],
  },
  '4-3-3': {
    id: '4-3-3',
    name: '4-3-3 Attack',
    slots: [
      { role: 'GK', x: 0.03, z: 0 },
      ...line('DF', 0.22, [-0.3, -0.1, 0.1, 0.3]),
      ...line('MF', 0.45, [-0.2, 0, 0.2]),
      ...line('FW', 0.71, [-0.3, 0, 0.3]),
    ],
  },
  '3-5-2': {
    id: '3-5-2',
    name: '3-5-2 Wing Play',
    slots: [
      { role: 'GK', x: 0.03, z: 0 },
      ...line('DF', 0.2, [-0.2, 0, 0.2]),
      ...line('MF', 0.46, [-0.38, -0.18, 0, 0.18, 0.38]),
      ...line('FW', 0.7, [-0.12, 0.12]),
    ],
  },
  '5-3-2': {
    id: '5-3-2',
    name: '5-3-2 Counter',
    slots: [
      { role: 'GK', x: 0.03, z: 0 },
      ...line('DF', 0.19, [-0.36, -0.18, 0, 0.18, 0.36]),
      ...line('MF', 0.44, [-0.24, 0, 0.24]),
      ...line('FW', 0.66, [-0.14, 0.14]),
    ],
  },
};

export const FORMATION_IDS = Object.keys(FORMATIONS) as FormationId[];
