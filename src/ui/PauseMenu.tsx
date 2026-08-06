import { useEffect } from 'react';
import { useGameStore } from '../game/store';

export function PauseMenu() {
  const paused = useGameStore((s) => s.paused);
  const setPaused = useGameStore((s) => s.setPaused);
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
