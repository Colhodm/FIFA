import { useEffect, useMemo } from 'react';
import { audio } from '../game/audio/audio';
import { Scene } from '../game/render/Scene';
import { disposeTextures } from '../game/render/textures';
import { attachDevices, runtime, setWorld } from '../game/runtime';
import { createWorld } from '../game/sim/state';
import { teamById, useGameStore, useHudStore } from '../game/store';
import { DebugPanel } from './DebugPanel';
import { FullTime } from './FullTime';
import { HalfTime } from './HalfTime';
import { Hud } from './Hud';
import { PauseMenu } from './PauseMenu';

export function Match() {
  const teams = useGameStore((s) => s.teams);
  const setup = useGameStore((s) => s.setup);
  const matchKey = useGameStore((s) => s.matchKey);
  const paused = useGameStore((s) => s.paused);
  const quitToMenu = useGameStore((s) => s.quitToMenu);
  const tuning = useGameStore((s) => s.config.tuning);
  const debug = useGameStore((s) => s.debug);

  const world = useMemo(() => {
    const home = teamById(teams, setup.homeTeamId);
    const away = teamById(teams, setup.awayTeamId);
    if (!home || !away) return null;
    return createWorld({
      homeTeam: home,
      awayTeam: away,
      homeFormation: setup.homeFormation,
      awayFormation: setup.awayFormation,
      humanSide: setup.humanSide,
      difficulty: setup.difficulty,
      halfLength: setup.halfLength,
      seed: matchKey * 7919 + 13,
      tuning,
    });
  }, [teams, setup, matchKey, tuning]);

  useEffect(() => {
    if (!world) return;
    attachDevices();
    setWorld(world);
    useHudStore.getState().set({
      phase: world.phase,
      score: { home: 0, away: 0 },
      minute: 0,
      half: 1,
      banner: world.banner,
      possession: { home: 50, away: 50 },
      shots: { home: 0, away: 0 },
    });
    return () => {
      setWorld(null);
      // The generated kit/seat/ball textures are only needed while a match is on screen.
      disposeTextures();
    };
  }, [world]);

  useEffect(() => {
    runtime.input.enabled = !paused;
    // Drop held keys and any pending buffer across the pause, so nothing is stuck down or
    // fires the moment play resumes.
    runtime.input.reset();
    if (paused) audio.setCrowdIntensity(0.05);
  }, [paused]);

  if (!world) {
    quitToMenu();
    return null;
  }

  return (
    <div className="match">
      <Scene key={matchKey} world={world} />
      <Hud />
      {import.meta.env.DEV && debug && <DebugPanel />}
      <PauseMenu />
      <HalfTime />
      <FullTime />
    </div>
  );
}
