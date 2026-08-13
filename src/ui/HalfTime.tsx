import { teamById, useGameStore, useHudStore } from '../game/store';
import { StatsPanel } from './StatsPanel';

/** Half-time interval: the stats screen, up until the referee restarts the match. */
export function HalfTime() {
  const phase = useHudStore((s) => s.phase);
  const score = useHudStore((s) => s.score);
  const stats = useHudStore((s) => s.stats);
  const possession = useHudStore((s) => s.possession);
  const feed = useHudStore((s) => s.feed);
  const teams = useGameStore((s) => s.teams);
  const setup = useGameStore((s) => s.setup);

  if (phase !== 'halftime') return null;

  const home = teamById(teams, setup.homeTeamId);
  const away = teamById(teams, setup.awayTeamId);

  return (
    <div className="overlay">
      <div className="panel wide">
        <h2>Half time</h2>
        <p className="final-score">
          {home?.name ?? 'Home'} {score.home} – {score.away} {away?.name ?? 'Away'}
        </p>
        <StatsPanel stats={stats} possession={possession} home={home} away={away} />
        {feed.length > 0 && (
          <ul className="feed-list">
            {feed.map((entry, i) => (
              <li key={`${entry.minute}-${i}`}>
                <span className="fd-min">{entry.minute}'</span> {entry.text}
              </li>
            ))}
          </ul>
        )}
        <p className="hint">Second half starts shortly…</p>
      </div>
    </div>
  );
}
