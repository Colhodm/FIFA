import { runtime } from '../game/runtime';
import { teamById, useGameStore, useHudStore } from '../game/store';
import { loadCup } from '../game/tournament';
import { Ratings, StatsPanel } from './StatsPanel';

export function FullTime() {
  const phase = useHudStore((s) => s.phase);
  const score = useHudStore((s) => s.score);
  const possession = useHudStore((s) => s.possession);
  const stats = useHudStore((s) => s.stats);
  const feed = useHudStore((s) => s.feed);
  const teams = useGameStore((s) => s.teams);
  const setup = useGameStore((s) => s.setup);
  const restartMatch = useGameStore((s) => s.restartMatch);
  const quitToMenu = useGameStore((s) => s.quitToMenu);
  const setScreen = useGameStore((s) => s.setScreen);

  if (phase !== 'end') return null;

  const cupPending = typeof loadCup()?.pendingAt === 'number';

  const home = teamById(teams, setup.homeTeamId);
  const away = teamById(teams, setup.awayTeamId);
  const human = setup.humanSide;
  const cpu = human === 'home' ? 'away' : 'home';
  const shootout = runtime.world?.shootout ?? null;
  const winner = shootout?.winner
    ? shootout.winner
    : score[human] === score[cpu]
      ? null
      : score[human] > score[cpu]
        ? human
        : cpu;
  const result = winner === null ? 'Draw' : winner === human ? 'You win!' : 'CPU wins';

  return (
    <div className="overlay">
      <div className="panel wide">
        <h2>Full time</h2>
        <p className="result">{result}</p>
        <p className="final-score">
          {home?.name ?? 'Home'} {score.home} – {score.away} {away?.name ?? 'Away'}
        </p>
        {shootout?.winner && (
          <p className="hint">
            {teamById(teams, shootout.winner === 'home' ? setup.homeTeamId : setup.awayTeamId)
              ?.name ?? 'Winners'}{' '}
            win {shootout.scores.home}–{shootout.scores.away} on penalties
          </p>
        )}
        <StatsPanel stats={stats} possession={possession} home={home} away={away} />
        <div className="ratings-row">
          <Ratings side="home" title={home?.shortName ?? 'Home'} />
          <Ratings side="away" title={away?.shortName ?? 'Away'} />
        </div>
        {feed.length > 0 && (
          <ul className="feed-list">
            {feed.map((entry, i) => (
              <li key={`${entry.minute}-${i}`}>
                <span className="fd-min">{entry.minute}'</span> {entry.text}
              </li>
            ))}
          </ul>
        )}
        {cupPending ? (
          <button type="button" onClick={() => setScreen('tournament')}>
            Back to cup
          </button>
        ) : (
          <button type="button" onClick={restartMatch}>
            Rematch
          </button>
        )}
        <button type="button" onClick={quitToMenu}>
          Main menu
        </button>
      </div>
    </div>
  );
}
