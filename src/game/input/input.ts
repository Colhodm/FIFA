import type { Vec2 } from '../sim/math';

/**
 * Actions mirror the FIFA "Classic" pad layout so a gamepad can be dropped in later without
 * touching gameplay code: `pass` = X/A, `cross` = Square/X, `through` = Triangle/Y,
 * `shoot` = Circle/B, `sprint` = R2, `jockey` = L2, `modR1`/`modL1` = the shoulder modifiers.
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
  actions: Record<ActionName, ButtonState>;
}

export interface RawInput {
  move: Vec2;
  buttons: Partial<Record<ActionName, boolean>>;
}

/**
 * Any device (keyboard today, gamepad/touch later) implements this. The manager merges every
 * source into a single frame so gameplay code never talks to a device directly.
 */
export interface InputSource {
  read(): RawInput;
  dispose(): void;
}

export const DEFAULT_BINDINGS: Record<string, ActionName | 'up' | 'down' | 'left' | 'right'> = {
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
  KeyZ: 'jockey',
  Space: 'switch',
  Tab: 'switch',
  Escape: 'pause',
  KeyP: 'pause',
};

export class KeyboardSource implements InputSource {
  private held = new Set<string>();
  private bindings: typeof DEFAULT_BINDINGS;
  private target: EventTarget;

  constructor(bindings = DEFAULT_BINDINGS, target: EventTarget = window) {
    this.bindings = bindings;
    this.target = target;
    this.target.addEventListener('keydown', this.onKeyDown as EventListener);
    this.target.addEventListener('keyup', this.onKeyUp as EventListener);
    window.addEventListener('blur', this.onBlur);
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
    const buttons: Record<string, boolean> = {};
    if (this.enabled) {
      for (const source of this.sources) {
        const raw = source.read();
        move.x += raw.move.x;
        move.z += raw.move.z;
        for (const action of ACTIONS) if (raw.buttons[action]) buttons[action] = true;
      }
    }
    const l = Math.hypot(move.x, move.z);
    this.frame.move = l > 1 ? { x: move.x / l, z: move.z / l } : move;
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
