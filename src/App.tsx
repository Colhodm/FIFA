import { useEffect } from 'react';
import { loadConfig } from './game/config';
import { loadTeams } from './game/data/teams';
import { useGameStore } from './game/store';
import { MainMenu } from './ui/MainMenu';
import { Match } from './ui/Match';

export default function App() {
  const screen = useGameStore((s) => s.screen);
  const setTeams = useGameStore((s) => s.setTeams);
  const setTeamsError = useGameStore((s) => s.setTeamsError);
  const setConfig = useGameStore((s) => s.setConfig);

  useEffect(() => {
    let cancelled = false;
    loadTeams()
      .then((teams) => {
        if (!cancelled) setTeams(teams);
      })
      .catch((error: unknown) => {
        if (!cancelled) setTeamsError(error instanceof Error ? error.message : String(error));
      });
    // Controls and tuning are data too, so a bad override never blocks the team list.
    loadConfig().then((config) => {
      if (!cancelled) setConfig(config);
    });
    return () => {
      cancelled = true;
    };
  }, [setTeams, setTeamsError, setConfig]);

  return screen === 'menu' ? <MainMenu /> : <Match />;
}
