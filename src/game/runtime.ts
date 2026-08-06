import type { Object3D } from 'three';
import type { RapierRigidBody } from '@react-three/rapier';
import { InputManager, KeyboardSource } from './input/input';
import type { SimWorld } from './sim/state';

/**
 * Mutable bridge between the fixed-timestep simulation and the React/R3F tree.
 * Nothing here is React state: the renderer reads it inside `useFrame`, so gameplay
 * updates never trigger re-renders.
 */
export interface Runtime {
  world: SimWorld | null;
  input: InputManager;
  /** Published by the chase camera, consumed by the sim to rotate input into pitch space. */
  cameraYaw: number;
  ball: RapierRigidBody | null;
  bodies: Map<number, RapierRigidBody>;
  /** Per-player visual groups, animated (bob, lean) independently of their colliders. */
  visuals: Map<number, Object3D>;
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
