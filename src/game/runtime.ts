import type { Group, Object3D } from 'three';
import type { RapierRigidBody } from '@react-three/rapier';
import { defaultConfig, type GameConfig } from './config';
import {
  GamepadSource,
  InputManager,
  KeyboardSource,
  type ActionName,
  type InputContext,
} from './input/input';
import type { Vec2 } from './sim/math';
import type { SimWorld } from './sim/state';
import type { SwitchCandidate } from './sim/switching';

/** Limb groups of one player, animated directly by the frame loop. */
export interface PlayerRig {
  root: Group;
  legL: Group;
  legR: Group;
  /** Knee pivots: the lower leg folds through the recovery stride instead of scissoring rigid. */
  shinL: Group;
  shinR: Group;
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
  /** Loop counters, so the tick rate the simulation actually achieves can be measured. */
  diag: { ticks: number; frames: number; starvedFrames: number };
  /** The live match camera, published so screen-space checks can be scripted. */
  camera: Object3D | null;
  /** Everything the F1 overlay draws. Written once per frame, read by the overlay. */
  debug: DebugState;
}

/** One completed charge, kept so the overlay can show the last few power readings. */
export interface ChargeSample {
  action: ActionName;
  /** Seconds the button was held. */
  hold: number;
  /** Normalised 0..1 charge that produced the kick. */
  charge: number;
  /** Ball speed the power curve asked for, m/s. */
  speed: number;
}

export interface DebugState {
  /** Raw stick/key vector, before the camera transform. */
  raw: Vec2;
  /** The same vector rotated into pitch space — what the player actually gets. */
  world: Vec2;
  context: InputContext;
  buffered: string | null;
  bufferAge: number;
  /** Best switch candidates, with their scores. */
  candidates: SwitchCandidate[];
  /** Ball position extrapolated along its velocity. */
  predicted: Vec2;
  /** Live charge, 0..1, and the action filling it. */
  charge: number;
  chargeAction: ActionName | null;
  holdSeconds: number;
  /** The last five completed charges, most recent last. */
  recent: ChargeSample[];
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
  diag: { ticks: 0, frames: 0, starvedFrames: 0 },
  camera: null,
  debug: {
    raw: { x: 0, z: 0 },
    world: { x: 0, z: 0 },
    context: 'ATTACK',
    buffered: null,
    bufferAge: 0,
    candidates: [],
    predicted: { x: 0, z: 0 },
    charge: 0,
    chargeAction: null,
    holdSeconds: 0,
    recent: [],
  },
};

declare global {
  // eslint-disable-next-line no-var
  var __fifa: Runtime | undefined;
}

// Dev-only handle so the live match can be inspected or nudged from the console.
if (import.meta.env.DEV) globalThis.__fifa = runtime;

let devicesAttached = false;
let gamepad: GamepadSource | null = null;
let keyboard: KeyboardSource | null = null;
let pendingConfig: GameConfig = defaultConfig();

export function attachDevices(): void {
  if (devicesAttached) return;
  keyboard = new KeyboardSource(pendingConfig.keyboard);
  runtime.input.add(keyboard);
  gamepad = new GamepadSource(pendingConfig.gamepad);
  runtime.input.add(gamepad);
  devicesAttached = true;
  applyConfig(pendingConfig);
}

/**
 * Pushes loaded bindings and tunables into the live input devices. Safe to call before the
 * devices exist: the config is held and applied when they are attached.
 */
export function applyConfig(config: GameConfig): void {
  pendingConfig = config;
  keyboard?.setBindings(config.keyboard);
  gamepad?.setBindings(config.gamepad);
  // Charge limits live with the input layer so "held past maximum" is resolved in one place.
  runtime.input.chargeLimits = {
    pass: config.tuning.pass.ground.maxChargeSeconds,
    cross: config.tuning.pass.lob.maxChargeSeconds,
    through: config.tuning.pass.through.maxChargeSeconds,
    shoot: config.tuning.shot.maxChargeSeconds,
  };
}

/** The tunables the next match will be created with. */
export const currentTuning = (): GameConfig['tuning'] => pendingConfig.tuning;

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
