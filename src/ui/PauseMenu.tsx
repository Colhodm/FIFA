import { useEffect, useMemo, useState } from 'react';
import { useGameStore } from '../game/store';
import type { CameraMode } from '../game/store';
import { runtime } from '../game/runtime';
import { benchFor, canSub, MAX_SUBS, requestSub } from '../game/sim/subs';

const CAMERAS: CameraMode[] = ['broadcast', 'tele', 'player'];

function Substitutions() {
  const world = runtime.world;
  const [outId, setOutId] = useState<number | ''>('');
  const [benchIndex, setBenchIndex] = useState<number | ''>('');
  // The sim world mutates outside React; bump this to re-read it after queueing a sub.
  const [, setVersion] = useState(0);

  const side = world?.config.humanSide ?? 'home';
  const onPitch = useMemo(
    () => (world ? world.players.filter((p) => p.side === side && !p.sentOff) : []),
    [world, side],
  );
  if (!world) return null;

  const bench = benchFor(world, side);
  const used = world.subsUsed[side] + world.pendingSubs.filter((s) => s.side === side).length;
  const valid = outId !== '' && benchIndex !== '' && canSub(world, side, outId, benchIndex);

  return (
    <div className="subs">
      <h3>
        Substitutions ({used}/{MAX_SUBS})
      </h3>
      {bench.length === 0 || used >= MAX_SUBS ? (
        <p className="hint">No substitutions available.</p>
      ) : (
        <>
          <label>
            Off
            <select
              value={outId}
              onChange={(e) => setOutId(e.target.value === '' ? '' : Number(e.target.value))}
            >
              <option value="">Select player</option>
              {onPitch.map((p) => (
                <option key={p.id} value={p.id}>
                  #{p.shirt} {p.name} ({p.role}) {Math.round(p.stamina * 100)}%
                </option>
              ))}
            </select>
          </label>
          <label>
            On
            <select
              value={benchIndex}
              onChange={(e) => setBenchIndex(e.target.value === '' ? '' : Number(e.target.value))}
            >
              <option value="">Select player</option>
              {bench.map((b) => (
                <option key={b.index} value={b.index}>
                  #{b.data.shirt} {b.data.name} ({b.data.role})
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!valid}
            onClick={() => {
              if (outId === '' || benchIndex === '') return;
              if (requestSub(world, side, outId, benchIndex)) {
                setOutId('');
                setBenchIndex('');
                setVersion((v) => v + 1);
              }
            }}
          >
            Make substitution
          </button>
        </>
      )}
      {world.pendingSubs.filter((s) => s.side === side).length > 0 && (
        <p className="hint">Queued — made at the next stoppage.</p>
      )}
    </div>
  );
}

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
        <Substitutions />
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
