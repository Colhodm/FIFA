import type { RestartKind } from '../game/sim/state';
import { teamById, useGameStore, useHudStore } from '../game/store';
import { Radar } from './Radar';

/** What the taker is being asked to do, keyboard-side. */
const SET_PIECE_HINT: Record<RestartKind, string> = {
  'throw-in': 'Aim with ← → ↑ ↓, A to throw short',
  'goal-kick': 'Hold A or D to launch it, aim with the arrows',
  corner: 'Aim with the arrows, hold S to whip it in',
  'free-kick': 'Aim with the arrows · hold D to shoot, S to cross',
  penalty: 'Aim with ← →, hold D for power',
};

const KEYBOARD_HINTS = [
  '← ↑ ↓ → move',
  'Shift sprint',
  'Z jockey',
  'A pass / contain',
  'S cross / slide',
  'Q through ball',
  'D shoot / tackle',
  'W driven · E lofted',
  'C skill move',
  'Space switch',
  'Esc pause',
];

const PAD_HINTS = [
  'L stick move',
  'RT sprint',
  'LT jockey',
  'A pass / contain',
  'X cross / slide',
  'Y through ball',
  'B shoot / tackle',
  'RB driven · LB lofted',
  'R stick skill move',
  'Back switch',
  'Start pause',
];

export function Hud() {
  const hud = useHudStore();
  const teams = useGameStore((s) => s.teams);
  const setup = useGameStore((s) => s.setup);
  const home = teamById(teams, setup.homeTeamId);
  const away = teamById(teams, setup.awayTeamId);
  const hints = hud.pad ? PAD_HINTS : KEYBOARD_HINTS;

  return (
    <div className="hud">
      {/* Broadcast bug: clock, then both clubs with their kit colour and the score. */}
      <div className="scoreboard">
        <span className="sb-clock">
          {hud.minute}'{hud.stoppage > 0 && <em className="sb-added">+{hud.stoppage}</em>}
          <small>{hud.half === 1 ? '1st' : '2nd'}</small>
        </span>
        <span className="sb-side">
          <i style={{ background: home?.kit.primary }} />
          {home?.shortName ?? 'HOM'}
          {hud.stats.home.reds > 0 && <b className="sb-red" />}
        </span>
        <span className="sb-score">
          {hud.score.home}–{hud.score.away}
        </span>
        <span className="sb-side">
          <i style={{ background: away?.kit.primary }} />
          {away?.shortName ?? 'AWY'}
          {hud.stats.away.reds > 0 && <b className="sb-red" />}
        </span>
      </div>

      <div className="perf">
        {hud.fps} fps · {hud.tierName}
      </div>

      {hud.replay && <div className="replay-tag">Replay</div>}
      {hud.banner && <div className="banner">{hud.banner}</div>}
      {hud.setPiece && <div className="setpiece">{SET_PIECE_HINT[hud.setPiece]}</div>}

      {hud.feed.length > 0 && (
        <ul className="feed">
          {hud.feed.slice(-3).map((entry, i) => (
            <li key={`${entry.minute}-${i}`} className={`fd-${entry.kind}`}>
              <span className="fd-min">{entry.minute}'</span> {entry.text}
            </li>
          ))}
        </ul>
      )}

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

      <Radar homeKit={home?.kit} awayKit={away?.kit} />

      <div className="hints">
        {hints.map((hint) => (
          <span key={hint}>{hint}</span>
        ))}
      </div>
    </div>
  );
}
