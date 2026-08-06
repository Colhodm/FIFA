import { teamById, useGameStore, useHudStore } from '../game/store';

export function FullTime() {
  const phase = useHudStore((s) => s.phase);
  const score = useHudStore((s) => s.score);
  const possession = useHudStore((s) => s.possession);
  const shots = useHudStore((s) => s.shots);
  const teams = useGameStore((s) => s.teams);
  const setup = useGameStore((s) => s.setup);
  const restartMatch = useGameStore((s) => s.restartMatch);
  const quitToMenu = useGameStore((s) => s.quitToMenu);

  if (phase !== 'end') return null;

  const home = teamById(teams, setup.homeTeamId);
  const away = teamById(teams, setup.awayTeamId);
  const result =
    score.home === score.away ? 'Draw' : score.home > score.away ? 'You win!' : 'CPU wins';

  return (
    <div className="overlay">
      <div className="panel wide">
        <h2>Full time</h2>
        <p className="result">{result}</p>
        <p className="final-score">
          {home?.name ?? 'Home'} {score.home} – {score.away} {away?.name ?? 'Away'}
        </p>
        <table className="stats">
          <tbody>
            <tr>
              <td>{possession.home}%</td>
              <th>Possession</th>
              <td>{possession.away}%</td>
            </tr>
            <tr>
              <td>{shots.home}</td>
              <th>Shots</th>
              <td>{shots.away}</td>
            </tr>
          </tbody>
        </table>
        <button type="button" onClick={restartMatch}>
          Rematch
        </button>
        <button type="button" onClick={quitToMenu}>
          Main menu
        </button>
      </div>
    </div>
  );
}
