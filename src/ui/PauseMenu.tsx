import { useEffect } from 'react';
import { useGameStore } from '../game/store';
import type { CameraMode } from '../game/store';

const CAMERAS: CameraMode[] = ['broadcast', 'tele', 'player'];

export function PauseMenu() {
  const paused = useGameStore((s) => s.paused);
  const camera = useGameStore((s) => s.camera);
  const setPaused = useGameStore((s) => s.setPaused);
  const setCamera = useGameStore((s) => s.setCamera);
  const restartMatch = useGameStore((s) => s.restartMatch);
  const quitToMenu = useGameStore((s) => s.quitToMenu);

  useEffect(() => {
    if (!paused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape' || e.code === 'KeyP') setPaused(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paused, setPaused]);

  if (!paused) return null;

  return (
    <div className="overlay">
      <div className="panel">
        <h2>Paused</h2>
        <label>
          Camera
          <div className="pill-row">
            {CAMERAS.map((mode) => (
              <button
                key={mode}
                type="button"
                className={`pill${camera === mode ? ' is-active' : ''}`}
                onClick={() => setCamera(mode)}
              >
                {mode}
              </button>
            ))}
          </div>
        </label>
        <button type="button" onClick={() => setPaused(false)}>
          Resume
        </button>
        <button type="button" onClick={restartMatch}>
          Restart match
        </button>
        <button type="button" onClick={quitToMenu}>
          Quit to menu
        </button>
      </div>
    </div>
  );
}
