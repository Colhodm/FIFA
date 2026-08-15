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
  | 'pause'
  | 'debug';

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
  'debug',
];

/** Actions that charge with a hold, and therefore fire on release. */
export const CHARGED_ACTIONS: ActionName[] = ['pass', 'cross', 'through', 'shoot'];

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
  /**
   * True for the single tick a charged action should actually be played — either because the
   * button came up, or because it reached full charge and auto-fired. Gameplay code reads this
   * instead of `released` so "hold past maximum" never waits forever for a release.
   */
  fired: boolean;
  /** Normalised 0..1 charge at the moment it fired. */
  charge: number;
  /** Set once a hold has auto-fired, so the eventual release does not fire a second time. */
  autoFired: boolean;
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

/**
 * Movement is on WASD *and* the arrows; the action buttons therefore live on the right hand,
 * laid out as the same diamond as a pad's face buttons:
 *
 * ```
 *        I  through
 *  J          L
 * cross     skill
 *        K  pass
 *
 *      Space  shoot
 * ```
 *
 * Shooting is on the spacebar deliberately: it is the highest-stakes, most time-pressured
 * action, it is the largest and most reliably-hit key, it is thumb-operated so the movement
 * fingers stay free to adjust aim during the power charge, and hold-and-release timing on it is
 * more consistent than on a letter key — which matters when power is hold-duration.
 *
 * Every one of these is overridable from `public/config/controls.json`.
 */
export const DEFAULT_BINDINGS: Record<string, BindingTarget> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyW: 'up',
  KeyS: 'down',
  KeyA: 'left',
  KeyD: 'right',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  KeyK: 'pass',
  KeyJ: 'cross',
  KeyI: 'through',
  KeyL: 'skill',
  KeyO: 'modR1',
  KeyU: 'modL1',
  Space: 'shoot',
  KeyQ: 'switch',
  Tab: 'switch',
  Escape: 'pause',
  KeyP: 'pause',
  F1: 'debug',
};

/** Keys the browser would otherwise act on while the match has focus. */
const ALWAYS_SUPPRESS = new Set(['Space', 'Tab', 'F1']);

export class KeyboardSource implements InputSource {
  private held = new Set<string>();
  /**
   * Keys pressed since the last poll, even if they have already come back up. The simulation
   * samples the keyboard once a tick, so without this latch any tap shorter than a tick is
   * dropped completely — and on a machine that is dipping below 60 fps, that is most of them.
   */
  private latched = new Set<string>();
  private bindings: Record<string, BindingTarget>;
  /** Reverse index so `read()` is a set lookup rather than a scan of every binding. */
  private byTarget = new Map<BindingTarget, string[]>();
  private target: EventTarget;

  constructor(
    bindings: Record<string, BindingTarget> = DEFAULT_BINDINGS,
    target: EventTarget = window,
  ) {
    this.bindings = bindings;
    this.reindex();
    this.target = target;
    this.target.addEventListener('keydown', this.onKeyDown as EventListener);
    this.target.addEventListener('keyup', this.onKeyUp as EventListener);
    window.addEventListener('blur', this.onBlur);
  }

  private reindex(): void {
    this.byTarget.clear();
    for (const [code, target] of Object.entries(this.bindings)) {
      const list = this.byTarget.get(target);
      if (list) list.push(code);
      else this.byTarget.set(target, [code]);
    }
  }

  /** Swaps the key map at runtime, so controls stay remappable from the pause menu. */
  setBindings(bindings: Record<string, BindingTarget>): void {
    this.bindings = bindings;
    this.reindex();
    this.held.clear();
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!(e.code in this.bindings)) return;
    // Leave browser/OS shortcuts (Cmd-R, Ctrl-T, Alt-Tab) alone.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (ALWAYS_SUPPRESS.has(e.code) || e.code.startsWith('Arrow')) e.preventDefault();
    // OS key-repeat is not a new physical press.
    if (e.repeat) return;
    this.held.add(e.code);
    this.latched.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.held.delete(e.code);
  };

  /** Losing focus must clear everything, or sprint sticks on when the player tabs back in. */
  private onBlur = () => {
    this.held.clear();
    this.latched.clear();
  };

  /** Drops all held keys — used when the match pauses so nothing is stuck down on resume. */
  releaseAll(): void {
    this.held.clear();
    this.latched.clear();
  }

  private on(target: BindingTarget): boolean {
    const codes = this.byTarget.get(target);
    if (!codes) return false;
    for (const code of codes) if (this.held.has(code) || this.latched.has(code)) return true;
    return false;
  }

  read(): RawInput {
    // Opposite keys cancel on their axis rather than fighting or jittering.
    const move = {
      x: (this.on('right') ? 1 : 0) - (this.on('left') ? 1 : 0),
      z: (this.on('up') ? 1 : 0) - (this.on('down') ? 1 : 0),
    };
    const l = Math.hypot(move.x, move.z);
    const buttons: Partial<Record<ActionName, boolean>> = {};
    for (const action of ACTIONS) if (this.on(action)) buttons[action] = true;
    // Each latched tap is surfaced for exactly one poll, then forgotten.
    this.latched.clear();
    // Normalise the diagonal so it is not 1.41x faster than a cardinal.
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
  fired: false,
  charge: 0,
  autoFired: false,
});

/** Seconds within which a second press counts as a double tap (lofted pass, ground cross). */
const DOUBLE_TAP_WINDOW = 0.28;

/** How long an action pressed during an animation lock waits for its turn. */
export const BUFFER_WINDOW = 0.25;

/** Which half of the control scheme the face buttons currently mean. */
export type InputContext = 'ATTACK' | 'DEFENCE';

/**
 * A single buffered action. The buffer holds only the most recent press: mashing pass then
 * shoot during a tackle recovery should play the shot, not a queue of both.
 */
export interface BufferedAction {
  action: ActionName;
  /** Seconds it has been waiting. */
  age: number;
  /** The context the button was pressed in, so a turnover cannot flip its meaning. */
  context: InputContext;
  /** Charge at the moment it was buffered, for actions that fire on release. */
  charge: number;
}

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

  /**
   * The live attack/defence context, and the one that was in force a moment ago. A press is
   * always resolved against the context at the time of the *press*, with a grace window, so a
   * pass squeezed off just as possession is lost never comes out as a jockey.
   */
  context: InputContext = 'ATTACK';
  private previousContext: InputContext = 'ATTACK';
  private sinceContextChange = Infinity;
  /** Seconds after a turnover during which a press still means what it did before. */
  readonly contextGrace = 0.25;

  buffer: BufferedAction | null = null;

  /**
   * Seconds of hold that count as full charge, per action. Set from the tuning config; an
   * action without a limit here is a plain button and never reports `fired`.
   */
  chargeLimits: Partial<Record<ActionName, number>> = {};

  add(source: InputSource): void {
    this.sources.push(source);
  }

  /** Clears every held key and pending buffer — used on pause, restart and phase changes. */
  /**
   * Abandons an in-progress charge: the next release of this action will not fire. This is what
   * makes the fake shot a real *cancel* — without it the feint played, and then the shot came
   * out anyway the moment the button was released, which railroaded every mistimed charge.
   */
  cancel(action: ActionName): void {
    const state = this.frame.actions[action];
    state.autoFired = true;
    state.charge = 0;
    state.heldTime = 0;
  }

  reset(): void {
    for (const source of this.sources) {
      if (source instanceof KeyboardSource) source.releaseAll();
    }
    for (const action of ACTIONS) {
      const state = this.frame.actions[action];
      state.down = false;
      state.pressed = false;
      state.released = false;
      state.heldTime = 0;
      state.doubleTap = false;
      state.fired = false;
      state.charge = 0;
      state.autoFired = false;
    }
    this.frame.move = { x: 0, z: 0 };
    this.frame.flick = { x: 0, z: 0 };
    this.buffer = null;
  }

  /** Published by the simulation each tick, since only it knows who has the ball. */
  setContext(context: InputContext): void {
    if (context === this.context) return;
    this.previousContext = this.context;
    this.context = context;
    this.sinceContextChange = 0;
  }

  /**
   * The context a press made *now* should be judged against: within the grace window after a
   * turnover the player's fingers were still acting on the old state, so honour that.
   */
  contextForPress(): InputContext {
    return this.sinceContextChange < this.contextGrace ? this.previousContext : this.context;
  }

  /** Remembers an action that could not be played yet. Only the most recent survives. */
  bufferAction(action: ActionName, charge: number): void {
    this.buffer = { action, age: 0, context: this.contextForPress(), charge };
  }

  /** Takes the buffered action if it is still fresh, clearing it either way. */
  takeBuffered(): BufferedAction | null {
    const pending = this.buffer;
    this.buffer = null;
    if (!pending || pending.age > BUFFER_WINDOW) return null;
    return pending;
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

      // Resolve the charge for hold-to-power actions.
      state.fired = false;
      if (state.pressed) state.autoFired = false;
      const limit = this.chargeLimits[action];
      if (limit !== undefined) {
        if (down && !state.autoFired && state.heldTime >= limit) {
          // Held past maximum: play it now at full power rather than waiting for a release.
          state.autoFired = true;
          state.fired = true;
          state.charge = 1;
        } else if (state.released && !state.autoFired) {
          state.fired = true;
          state.charge = Math.min(1, state.heldTime / limit);
        }
      }
    }
    this.sinceContextChange += dt;
    if (this.buffer) {
      this.buffer.age += dt;
      // Stale buffers are dropped rather than fired late.
      if (this.buffer.age > BUFFER_WINDOW) this.buffer = null;
    }
    return this.frame;
  }

  dispose(): void {
    for (const source of this.sources) source.dispose();
    this.sources = [];
  }
}
