import { assetUrl } from './audio/audio';
import {
  ACTIONS,
  DEFAULT_BINDINGS,
  DEFAULT_PAD_BINDINGS,
  type ActionName,
  type BindingTarget,
} from './input/input';
import { DEFAULT_TUNING, type Tuning } from './tuning';

export type { PowerTuning, Tuning } from './tuning';
export { DEFAULT_TUNING } from './tuning';

export interface ControlsFile {
  /** Maps a KeyboardEvent.code to a movement direction or an action. */
  keyboard?: Record<string, BindingTarget>;
  /** Maps a standard-gamepad button index to an action. */
  gamepad?: Record<string, ActionName>;
  /** When true the file replaces the defaults instead of layering over them. */
  replaceDefaults?: boolean;
}

export interface GameConfig {
  keyboard: Record<string, BindingTarget>;
  gamepad: Record<number, ActionName>;
  tuning: Tuning;
}

const TARGETS = new Set<string>([...ACTIONS, 'up', 'down', 'left', 'right']);

const isTarget = (value: unknown): value is BindingTarget =>
  typeof value === 'string' && TARGETS.has(value);

/** Deep-merges plain objects so a partial tuning file only overrides what it mentions. */
function merge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return (patch === undefined ? base : (patch as T)) ?? base;
  }
  const out = { ...(base as object) } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = out[key];
    out[key] =
      current !== null && typeof current === 'object' && !Array.isArray(current)
        ? merge(current, value)
        : value;
  }
  return out as T;
}

export const defaultConfig = (): GameConfig => ({
  keyboard: { ...DEFAULT_BINDINGS },
  gamepad: { ...DEFAULT_PAD_BINDINGS },
  tuning: DEFAULT_TUNING,
});

/**
 * Loads `public/config/controls.json` and `public/config/tuning.json` over the built-in
 * defaults. Missing or malformed files are not fatal: the game falls back to the defaults so a
 * bad override can never lock the player out of their controls.
 */
export async function loadConfig(): Promise<GameConfig> {
  const config = defaultConfig();

  try {
    const res = await fetch(assetUrl('config/controls.json'));
    if (res.ok) {
      const file = (await res.json()) as ControlsFile;
      if (file.replaceDefaults) {
        config.keyboard = {};
        config.gamepad = {};
      }
      for (const [code, target] of Object.entries(file.keyboard ?? {})) {
        // Silently dropping an unknown action would be worse than ignoring the whole entry.
        if (isTarget(target)) config.keyboard[code] = target;
        else console.warn(`controls.json: ignoring unknown binding "${code}" -> "${target}"`);
      }
      for (const [index, action] of Object.entries(file.gamepad ?? {})) {
        if (isTarget(action) && (ACTIONS as string[]).includes(action)) {
          config.gamepad[Number(index)] = action as ActionName;
        }
      }
    }
  } catch {
    // No controls file: built-in bindings.
  }

  try {
    const res = await fetch(assetUrl('config/tuning.json'));
    if (res.ok) config.tuning = merge(DEFAULT_TUNING, await res.json());
  } catch {
    // No tuning file: built-in numbers.
  }

  return config;
}
