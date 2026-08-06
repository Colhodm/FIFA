import { teamById, useGameStore, useHudStore } from '../game/store';

export function Hud() {
  const hud = useHudStore();
  const teams = useGameStore((s) => s.teams);
  const setup = useGameStore((s) => s.setup);
  const home = teamById(teams, setup.homeTeamId);
  const away = teamById(teams, setup.awayTeamId);

  return (
    <div className="hud">
      <div className="scoreboard">
        <span className="sb-team" style={{ borderColor: home?.kit.primary }}>
          {home?.shortName ?? 'HOM'}
        </span>
        <span className="sb-score">
          {hud.score.home} – {hud.score.away}
        </span>
        <span className="sb-team" style={{ borderColor: away?.kit.primary }}>
          {away?.shortName ?? 'AWY'}
        </span>
        <span className="sb-clock">
          {hud.minute}'<small>{hud.half === 1 ? '1st' : '2nd'}</small>
        </span>
      </div>

      <div className="perf">
        {hud.fps} fps · {hud.tierName}
      </div>

      {hud.banner && <div className="banner">{hud.banner}</div>}

      <div className="player-card">
        <div className="pc-top">
          <span className="pc-shirt">{hud.activeShirt}</span>
          <span className="pc-name">{hud.activeName || '—'}</span>
        </div>
        <div className="bar stamina">
          <span style={{ width: `${Math.round(hud.stamina * 100)}%` }} />
        </div>
        <div className={`bar charge${hud.charge > 0 ? ' is-live' : ''}`}>
          <span style={{ width: `${Math.round(hud.charge * 100)}%` }} />
        </div>
        <div className="pc-stats">
          possession {hud.possession.home}% · shots {hud.shots.home}-{hud.shots.away}
        </div>
      </div>

      <div className="hints">
        <span>WASD move</span>
        <span>Shift sprint</span>
        <span>K pass</span>
        <span>L shoot</span>
        <span>J tackle</span>
        <span>Q switch</span>
        <span>Esc pause</span>
      </div>
    </div>
  );
}
