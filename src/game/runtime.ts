import type { Group, Object3D } from 'three';
import type { RapierRigidBody } from '@react-three/rapier';
import { InputManager, KeyboardSource } from './input/input';
import type { SimWorld } from './sim/state';

/** Limb groups of one player, animated directly by the frame loop. */
export interface PlayerRig {
  root: Group;
  legL: Group;
  legR: Group;
  armL: Group;
  armR: Group;
}

/**
 * Mutable bridge between the fixed-timestep simulation and the React/R3F tree.
 * Nothing here is React state: the renderer reads it inside `useFrame`, so gameplay
 * updates never trigger re-renders.
 */
export interface Runtime {
  world: SimWorld | null;
  input: InputManager;
  /** Published by the match camera, consumed by the sim to rotate input into pitch space. */
  cameraYaw: number;
  ball: RapierRigidBody | null;
  bodies: Map<number, RapierRigidBody>;
  /** Per-player rigs, animated (run cycle, lean) independently of their colliders. */
  visuals: Map<number, PlayerRig>;
  /** Ring drawn under the player the human is controlling. */
  indicator: Object3D | null;
  /** 0..1 shot/pass charge, mirrored to the HUD. */
  charge: number;
  frozen: boolean;
}

export const runtime: Runtime = {
  world: null,
  input: new InputManager(),
  cameraYaw: 0,
  ball: null,
  bodies: new Map(),
  visuals: new Map(),
  indicator: null,
  charge: 0,
  frozen: false,
};

declare global {
  // eslint-disable-next-line no-var
  var __fifa: Runtime | undefined;
}

// Dev-only handle so the live match can be inspected or nudged from the console.
if (import.meta.env.DEV) globalThis.__fifa = runtime;

let keyboardAttached = false;

export function attachKeyboard(): void {
  if (keyboardAttached) return;
  runtime.input.add(new KeyboardSource());
  keyboardAttached = true;
}

export function setWorld(world: SimWorld | null): void {
  runtime.world = world;
  runtime.bodies.clear();
  runtime.visuals.clear();
  runtime.ball = null;
  runtime.indicator = null;
  runtime.charge = 0;
}
