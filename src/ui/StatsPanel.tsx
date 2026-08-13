import { runtime } from '../game/runtime';
import { matchRating, type MatchStats } from '../game/sim/state';
import type { TeamData, TeamSide } from '../game/types';

const ROWS: { key: keyof MatchStats | 'possession'; label: string }[] = [
  { key: 'possession', label: 'Possession' },
  { key: 'shots', label: 'Shots' },
  { key: 'onTarget', label: 'On target' },
  { key: 'passes', label: 'Passes' },
  { key: 'saves', label: 'Saves' },
  { key: 'corners', label: 'Corners' },
  { key: 'fouls', label: 'Fouls' },
  { key: 'offsides', label: 'Offsides' },
  { key: 'yellows', label: 'Yellow cards' },
  { key: 'reds', label: 'Red cards' },
];

interface Props {
  stats: Record<TeamSide, MatchStats>;
  possession: Record<TeamSide, number>;
  home?: TeamData;
  away?: TeamData;
}

/** Broadcast-style match stats, shared by the half-time and full-time screens. */
export function StatsPanel({ stats, possession, home, away }: Props) {
  return (
    <table className="stats">
      <thead>
        <tr>
          <th>{home?.shortName ?? 'HOM'}</th>
          <th />
          <th>{away?.shortName ?? 'AWY'}</th>
        </tr>
      </thead>
      <tbody>
        {ROWS.map(({ key, label }) => {
          const h = key === 'possession' ? `${possession.home}%` : stats.home[key];
          const a = key === 'possession' ? `${possession.away}%` : stats.away[key];
          return (
            <tr key={label}>
              <td>{h}</td>
              <th>{label}</th>
              <td>{a}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Player ratings for one side, best first — the sim keeps the tallies these come from. */
export function Ratings({ side, title }: { side: TeamSide; title: string }) {
  const world = runtime.world;
  if (!world) return null;
  const players = world.players
    .filter((p) => p.side === side)
    .map((p) => ({ player: p, rating: matchRating(p) }))
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 5);

  return (
    <div className="ratings">
      <h3>{title}</h3>
      <ul>
        {players.map(({ player, rating }) => (
          <li key={player.id}>
            <span className="rt-shirt">{player.shirt}</span>
            <span className="rt-name">{player.name}</span>
            <span className={`rt-score${rating >= 7.5 ? ' is-good' : ''}`}>
              {rating.toFixed(1)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
