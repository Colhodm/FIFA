import type { Group, Object3D } from 'three';
import type { RapierRigidBody } from '@react-three/rapier';
import { GamepadSource, InputManager, KeyboardSource } from './input/input';
import type { SimWorld } from './sim/state';

/** Limb groups of one player, animated directly by the frame loop. */
export interface PlayerRig {
  root: Group;
  legL: Group;
  legR: Group;
  armL: Group;
  armR: Group;
  torso: Group;
}

/** One stored frame of a goal, replayed from a cinematic angle. */
export interface ReplayFrame {
  ball: { x: number; y: number; z: number };
  players: { id: number; x: number; z: number; heading: number; height: number; gait: number }[];
}

export interface ReplayState {
  /** Ring buffer of the last few seconds of play. */
  buffer: ReplayFrame[];
  playing: boolean;
  /** Playback cursor, in frames. */
  cursor: number;
  speed: number;
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
  /** Arrow shown on set pieces, pointing where the taker is aiming. */
  aim: Object3D | null;
  /** 0..1 shot/pass charge, mirrored to the HUD. */
  charge: number;
  frozen: boolean;
  /** Goal replays, driven by the frame loop rather than the simulation. */
  replay: ReplayState;
  /** Impact point of a ball hitting the net, so the netting can ripple where it struck. */
  netHit: { dir: 1 | -1; t: number; z: number; y: number } | null;
  /** True once a gamepad has been seen, so the HUD can switch its control hints. */
  padConnected: boolean;
}

export const runtime: Runtime = {
  world: null,
  input: new InputManager(),
  cameraYaw: 0,
  ball: null,
  bodies: new Map(),
  visuals: new Map(),
  indicator: null,
  aim: null,
  charge: 0,
  frozen: false,
  replay: { buffer: [], playing: false, cursor: 0, speed: 0.55 },
  netHit: null,
  padConnected: false,
};

declare global {
  // eslint-disable-next-line no-var
  var __fifa: Runtime | undefined;
}

// Dev-only handle so the live match can be inspected or nudged from the console.
if (import.meta.env.DEV) globalThis.__fifa = runtime;

let devicesAttached = false;
let gamepad: GamepadSource | null = null;

export function attachDevices(): void {
  if (devicesAttached) return;
  runtime.input.add(new KeyboardSource());
  gamepad = new GamepadSource();
  runtime.input.add(gamepad);
  devicesAttached = true;
}

/** Polled by the HUD: true while a pad is driving the match. */
export const padConnected = (): boolean => gamepad?.connected ?? false;

export function setWorld(world: SimWorld | null): void {
  runtime.world = world;
  runtime.bodies.clear();
  runtime.visuals.clear();
  runtime.ball = null;
  runtime.indicator = null;
  runtime.aim = null;
  runtime.charge = 0;
  runtime.replay = { buffer: [], playing: false, cursor: 0, speed: 0.55 };
  runtime.netHit = null;
}
