import type { Vec2 } from '../sim/math';

/**
 * Actions mirror the FIFA "Classic" pad layout so every device maps onto the same gameplay
 * code: `pass` = X/A, `cross` = Square/X, `through` = Triangle/Y, `shoot` = Circle/B,
 * `sprint` = R2, `jockey` = L2, `modR1`/`modL1` = the shoulder modifiers, `skill` = right stick.
 * Defending reuses the same face buttons, exactly as the pad does.
 */
export type ActionName =
  | 'pass'
  | 'cross'
  | 'through'
  | 'shoot'
  | 'sprint'
  | 'jockey'
  | 'modR1'
  | 'modL1'
  | 'skill'
  | 'switch'
  | 'pause';

export const ACTIONS: ActionName[] = [
  'pass',
  'cross',
  'through',
  'shoot',
  'sprint',
  'jockey',
  'modR1',
  'modL1',
  'skill',
  'switch',
  'pause',
];

export interface ButtonState {
  down: boolean;
  /** True for the single frame the button went down. */
  pressed: boolean;
  /** True for the single frame the button came up. */
  released: boolean;
  /** Seconds the button has been held (frozen at release time for one frame). */
  heldTime: number;
  /** True when this press followed a previous press within the double-tap window. */
  doubleTap: boolean;
}

export interface InputFrame {
  /** Camera-relative movement, x = right, z = forward, magnitude <= 1. */
  move: Vec2;
  /** Camera-relative right stick, used for skill moves. Zero on keyboard. */
  flick: Vec2;
  actions: Record<ActionName, ButtonState>;
}

export interface RawInput {
  move: Vec2;
  flick?: Vec2;
  buttons: Partial<Record<ActionName, boolean>>;
}

/**
 * Any device (keyboard, gamepad, touch later) implements this. The manager merges every
 * source into a single frame so gameplay code never talks to a device directly.
 */
export interface InputSource {
  read(): RawInput;
  dispose(): void;
}

export type BindingTarget = ActionName | 'up' | 'down' | 'left' | 'right';

export const DEFAULT_BINDINGS: Record<string, BindingTarget> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  KeyA: 'pass',
  KeyS: 'cross',
  KeyQ: 'through',
  KeyD: 'shoot',
  KeyW: 'modR1',
  KeyE: 'modL1',
  KeyC: 'skill',
  KeyZ: 'jockey',
  Space: 'switch',
  Tab: 'switch',
  Escape: 'pause',
  KeyP: 'pause',
};

export class KeyboardSource implements InputSource {
  private held = new Set<string>();
  private bindings: Record<string, BindingTarget>;
  private target: EventTarget;

  constructor(
    bindings: Record<string, BindingTarget> = DEFAULT_BINDINGS,
    target: EventTarget = window,
  ) {
    this.bindings = bindings;
    this.target = target;
    this.target.addEventListener('keydown', this.onKeyDown as EventListener);
    this.target.addEventListener('keyup', this.onKeyUp as EventListener);
    window.addEventListener('blur', this.onBlur);
  }

  /** Swaps the key map at runtime, so controls stay remappable from the pause menu. */
  setBindings(bindings: Record<string, BindingTarget>): void {
    this.bindings = bindings;
    this.held.clear();
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!(e.code in this.bindings)) return;
    if (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow')) e.preventDefault();
    if (e.repeat) return;
    this.held.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.held.delete(e.code);
  };

  private onBlur = () => this.held.clear();

  read(): RawInput {
    const on = (name: string) =>
      Object.entries(this.bindings).some(
        ([code, action]) => action === name && this.held.has(code),
      );
    const move = {
      x: (on('right') ? 1 : 0) - (on('left') ? 1 : 0),
      z: (on('up') ? 1 : 0) - (on('down') ? 1 : 0),
    };
    const l = Math.hypot(move.x, move.z);
    const buttons: Partial<Record<ActionName, boolean>> = {};
    for (const action of ACTIONS) if (on(action)) buttons[action] = true;
    return { move: l > 1 ? { x: move.x / l, z: move.z / l } : move, buttons };
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown as EventListener);
    this.target.removeEventListener('keyup', this.onKeyUp as EventListener);
    window.removeEventListener('blur', this.onBlur);
    this.held.clear();
  }
}

/** Standard-gamepad button indices, in the FIFA control layout. */
export const DEFAULT_PAD_BINDINGS: Record<number, ActionName> = {
  0: 'pass', // A / cross
  1: 'shoot', // B / circle
  2: 'cross', // X / square
  3: 'through', // Y / triangle
  4: 'modL1', // LB / L1
  5: 'modR1', // RB / R1
  6: 'jockey', // LT / L2
  7: 'sprint', // RT / R2
  8: 'switch', // back / share
  9: 'pause', // start / options
};

const STICK_DEADZONE = 0.24;
const TRIGGER_THRESHOLD = 0.35;

const deadzone = (x: number, z: number): Vec2 => {
  const l = Math.hypot(x, z);
  if (l < STICK_DEADZONE) return { x: 0, z: 0 };
  // Rescale so the stick still reaches full throw after the deadzone is removed.
  const scale = Math.min(1, (l - STICK_DEADZONE) / (1 - STICK_DEADZONE)) / l;
  return { x: x * scale, z: z * scale };
};

/**
 * Gamepad API source: left stick moves, right stick plays skill moves, triggers sprint and
 * jockey, face buttons pass/shoot/cross/through. The first connected pad wins.
 */
export class GamepadSource implements InputSource {
  private bindings: Record<number, ActionName>;
  private index: number | null = null;

  constructor(bindings: Record<number, ActionName> = DEFAULT_PAD_BINDINGS) {
    this.bindings = bindings;
    window.addEventListener('gamepadconnected', this.onConnect);
    window.addEventListener('gamepaddisconnected', this.onDisconnect);
  }

  setBindings(bindings: Record<number, ActionName>): void {
    this.bindings = bindings;
  }

  /** True while a pad is connected, so the HUD can show pad hints instead of keys. */
  get connected(): boolean {
    return this.pad() !== null;
  }

  private onConnect = (e: Event) => {
    const pad = (e as GamepadEvent).gamepad;
    if (this.index === null) this.index = pad.index;
  };

  private onDisconnect = (e: Event) => {
    if ((e as GamepadEvent).gamepad.index === this.index) this.index = null;
  };

  private pad(): Gamepad | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    if (this.index !== null) {
      const current = pads[this.index];
      if (current && current.connected) return current;
      this.index = null;
    }
    for (const pad of pads) {
      if (pad && pad.connected) {
        this.index = pad.index;
        return pad;
      }
    }
    return null;
  }

  read(): RawInput {
    const pad = this.pad();
    if (!pad) return { move: { x: 0, z: 0 }, buttons: {} };
    const axes = pad.axes;
    // Sticks report +y as down, and the pitch's +z is up the screen.
    const move = deadzone(axes[0] ?? 0, -(axes[1] ?? 0));
    const flick = deadzone(axes[2] ?? 0, -(axes[3] ?? 0));
    const buttons: Partial<Record<ActionName, boolean>> = {};
    for (const [index, action] of Object.entries(this.bindings)) {
      const button = pad.buttons[Number(index)];
      if (!button) continue;
      // Triggers are analogue: treat anything past the threshold as held.
      if (button.pressed || button.value > TRIGGER_THRESHOLD) buttons[action] = true;
    }
    if (Math.hypot(flick.x, flick.z) > 0.75) buttons.skill = true;
    return { move, flick, buttons };
  }

  dispose(): void {
    window.removeEventListener('gamepadconnected', this.onConnect);
    window.removeEventListener('gamepaddisconnected', this.onDisconnect);
    this.index = null;
  }
}

const emptyButton = (): ButtonState => ({
  down: false,
  pressed: false,
  released: false,
  heldTime: 0,
  doubleTap: false,
});

/** Seconds within which a second press counts as a double tap (lofted pass, ground cross). */
const DOUBLE_TAP_WINDOW = 0.28;

export class InputManager {
  readonly frame: InputFrame = {
    move: { x: 0, z: 0 },
    flick: { x: 0, z: 0 },
    actions: Object.fromEntries(ACTIONS.map((a) => [a, emptyButton()])) as Record<
      ActionName,
      ButtonState
    >,
  };
  private sources: InputSource[] = [];
  private sinceRelease: Record<string, number> = {};
  /** Set false while a menu is open so the pitch does not react to menu keys. */
  enabled = true;

  add(source: InputSource): void {
    this.sources.push(source);
  }

  /** Sample every source and fold it into one frame. Call once per simulation tick. */
  update(dt: number): InputFrame {
    const move = { x: 0, z: 0 };
    const flick = { x: 0, z: 0 };
    const buttons: Record<string, boolean> = {};
    if (this.enabled) {
      for (const source of this.sources) {
        const raw = source.read();
        move.x += raw.move.x;
        move.z += raw.move.z;
        if (raw.flick) {
          flick.x += raw.flick.x;
          flick.z += raw.flick.z;
        }
        for (const action of ACTIONS) if (raw.buttons[action]) buttons[action] = true;
      }
    }
    const l = Math.hypot(move.x, move.z);
    this.frame.move = l > 1 ? { x: move.x / l, z: move.z / l } : move;
    const fl = Math.hypot(flick.x, flick.z);
    this.frame.flick = fl > 1 ? { x: flick.x / fl, z: flick.z / fl } : flick;
    for (const action of ACTIONS) {
      const state = this.frame.actions[action];
      const down = Boolean(buttons[action]);
      state.pressed = down && !state.down;
      state.released = !down && state.down;
      const gap = (this.sinceRelease[action] ?? Infinity) + dt;
      if (state.pressed) state.doubleTap = gap < DOUBLE_TAP_WINDOW;
      this.sinceRelease[action] = state.released ? 0 : gap;
      if (down) state.heldTime += dt;
      else if (!state.released) state.heldTime = 0;
      state.down = down;
    }
    return this.frame;
  }

  dispose(): void {
    for (const source of this.sources) source.dispose();
    this.sources = [];
  }
}
