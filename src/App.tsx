import { useEffect } from 'react';
import { loadTeams } from './game/data/teams';
import { useGameStore } from './game/store';
import { MainMenu } from './ui/MainMenu';
import { Match } from './ui/Match';

export default function App() {
  const screen = useGameStore((s) => s.screen);
  const setTeams = useGameStore((s) => s.setTeams);
  const setTeamsError = useGameStore((s) => s.setTeamsError);

  useEffect(() => {
    let cancelled = false;
    loadTeams()
      .then((teams) => {
        if (!cancelled) setTeams(teams);
      })
      .catch((error: unknown) => {
        if (!cancelled) setTeamsError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [setTeams, setTeamsError]);

  return screen === 'menu' ? <MainMenu /> : <Match />;
}
