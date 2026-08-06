import type { Vec2 } from '../sim/math';

export type ActionName = 'pass' | 'shoot' | 'sprint' | 'tackle' | 'switch' | 'pause';

export const ACTIONS: ActionName[] = ['pass', 'shoot', 'sprint', 'tackle', 'switch', 'pause'];

export interface ButtonState {
  down: boolean;
  /** True for the single frame the button went down. */
  pressed: boolean;
  /** True for the single frame the button came up. */
  released: boolean;
  /** Seconds the button has been held (frozen at release time for one frame). */
  heldTime: number;
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
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  KeyK: 'pass',
  Space: 'pass',
  KeyL: 'shoot',
  KeyJ: 'tackle',
  KeyQ: 'switch',
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
    return {
      move: l > 1 ? { x: move.x / l, z: move.z / l } : move,
      buttons: {
        sprint: on('sprint'),
        pass: on('pass'),
        shoot: on('shoot'),
        tackle: on('tackle'),
        switch: on('switch'),
        pause: on('pause'),
      },
    };
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
});

export class InputManager {
  readonly frame: InputFrame = {
    move: { x: 0, z: 0 },
    actions: Object.fromEntries(ACTIONS.map((a) => [a, emptyButton()])) as Record<
      ActionName,
      ButtonState
    >,
  };
  private sources: InputSource[] = [];
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
