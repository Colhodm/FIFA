import { audio } from '../game/audio/audio';
import { FORMATIONS, FORMATION_IDS } from '../game/formations';
import { useGameStore } from '../game/store';
import type { CameraMode } from '../game/store';
import type { Difficulty, FormationId, MatchMode, TeamData } from '../game/types';

const DIFFICULTIES: Difficulty[] = ['beginner', 'normal', 'hard', 'legendary'];
const MODES: { id: MatchMode; label: string }[] = [
  { id: 'friendly', label: 'friendly' },
  { id: 'knockout', label: 'knockout' },
];
const HALF_LENGTHS = [120, 180, 300, 600];
const CAMERAS: { id: CameraMode; label: string }[] = [
  { id: 'broadcast', label: 'broadcast' },
  { id: 'tele', label: 'tele' },
  { id: 'player', label: 'player' },
];

function TeamCard({
  team,
  selected,
  onSelect,
}: {
  team: TeamData;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`team-card${selected ? ' is-selected' : ''}`}
      onClick={onSelect}
    >
      <span className="team-kit">
        <span style={{ background: team.kit.primary }} />
        <span style={{ background: team.kit.secondary }} />
        <span style={{ background: team.kit.shorts }} />
      </span>
      <span className="team-name">{team.name}</span>
      <span className="team-meta">
        {team.shortName} · {team.formation} · OVR {team.rating}
      </span>
    </button>
  );
}

export function MainMenu() {
  const teams = useGameStore((s) => s.teams);
  const teamsError = useGameStore((s) => s.teamsError);
  const setup = useGameStore((s) => s.setup);
  const quality = useGameStore((s) => s.quality);
  const camera = useGameStore((s) => s.camera);
  const audioEnabled = useGameStore((s) => s.audioEnabled);
  const updateSetup = useGameStore((s) => s.updateSetup);
  const setQuality = useGameStore((s) => s.setQuality);
  const setCamera = useGameStore((s) => s.setCamera);
  const toggleAudio = useGameStore((s) => s.toggleAudio);
  const startMatch = useGameStore((s) => s.startMatch);

  const ready = teams.length >= 2 && setup.homeTeamId && setup.awayTeamId;

  const kickOff = () => {
    if (!ready) return;
    if (audioEnabled) void audio.resume();
    audio.setEnabled(audioEnabled);
    startMatch();
  };

  return (
    <div className="menu">
      <header className="menu-header">
        <h1>Browser FIFA</h1>
        <p>
          Single player vs CPU · Premier League squads, unofficial · not affiliated with any club or
          league
        </p>
      </header>

      {/* The whole control scheme is a keyboard; a phone cannot play this. Say so up front. */}
      {isProbablyMobile() && (
        <p className="error">
          This game needs a keyboard — please open it on a desktop or laptop. Mobile is not
          supported.
        </p>
      )}

      {teamsError && <p className="error">{teamsError}</p>}
      {!teams.length && !teamsError && <p className="muted">Loading teams…</p>}

      <div className="team-select">
        <section>
          <h2>Your team</h2>
          <div className="team-grid">
            {teams.map((team) => (
              <TeamCard
                key={team.id}
                team={team}
                selected={team.id === setup.homeTeamId}
                onSelect={() =>
                  updateSetup({
                    homeTeamId: team.id,
                    homeFormation: team.formation,
                    awayTeamId:
                      team.id === setup.awayTeamId
                        ? (teams.find((t) => t.id !== team.id)?.id ?? setup.awayTeamId)
                        : setup.awayTeamId,
                  })
                }
              />
            ))}
          </div>
          <label>
            Formation
            <select
              value={setup.homeFormation}
              onChange={(e) => updateSetup({ homeFormation: e.target.value as FormationId })}
            >
              {FORMATION_IDS.map((id) => (
                <option key={id} value={id}>
                  {FORMATIONS[id].name}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section>
          <h2>CPU team</h2>
          <div className="team-grid">
            {teams.map((team) => (
              <TeamCard
                key={team.id}
                team={team}
                selected={team.id === setup.awayTeamId}
                onSelect={() =>
                  updateSetup({
                    awayTeamId: team.id,
                    awayFormation: team.formation,
                    homeTeamId:
                      team.id === setup.homeTeamId
                        ? (teams.find((t) => t.id !== team.id)?.id ?? setup.homeTeamId)
                        : setup.homeTeamId,
                  })
                }
              />
            ))}
          </div>
          <label>
            Formation
            <select
              value={setup.awayFormation}
              onChange={(e) => updateSetup({ awayFormation: e.target.value as FormationId })}
            >
              {FORMATION_IDS.map((id) => (
                <option key={id} value={id}>
                  {FORMATIONS[id].name}
                </option>
              ))}
            </select>
          </label>
        </section>
      </div>

      <div className="options">
        <label>
          Match type
          <div className="pill-row">
            {MODES.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className={`pill${setup.mode === id ? ' is-active' : ''}`}
                onClick={() => updateSetup({ mode: id })}
              >
                {label}
              </button>
            ))}
          </div>
        </label>

        <label>
          Difficulty
          <div className="pill-row">
            {DIFFICULTIES.map((d) => (
              <button
                key={d}
                type="button"
                className={`pill${setup.difficulty === d ? ' is-active' : ''}`}
                onClick={() => updateSetup({ difficulty: d })}
              >
                {d}
              </button>
            ))}
          </div>
        </label>

        <label>
          Half length
          <div className="pill-row">
            {HALF_LENGTHS.map((seconds) => (
              <button
                key={seconds}
                type="button"
                className={`pill${setup.halfLength === seconds ? ' is-active' : ''}`}
                onClick={() => updateSetup({ halfLength: seconds })}
              >
                {seconds / 60} min
              </button>
            ))}
          </div>
        </label>

        <label>
          Camera
          <div className="pill-row">
            {CAMERAS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className={`pill${camera === id ? ' is-active' : ''}`}
                onClick={() => setCamera(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </label>

        <label>
          Quality
          <div className="pill-row">
            {(['auto', 'low', 'medium', 'high', 'ultra'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`pill${quality === mode ? ' is-active' : ''}`}
                onClick={() => setQuality(mode)}
              >
                {mode}
              </button>
            ))}
          </div>
        </label>

        <label>
          Sound
          <div className="pill-row">
            <button
              type="button"
              className={`pill${audioEnabled ? ' is-active' : ''}`}
              onClick={() => {
                toggleAudio();
                audio.setEnabled(!audioEnabled);
              }}
            >
              {audioEnabled ? 'on' : 'off'}
            </button>
          </div>
        </label>
      </div>

      <button type="button" className="kickoff" disabled={!ready} onClick={kickOff}>
        Kick off
      </button>

      <footer className="controls-help">
        <span>
          <b>Arrows</b> move
        </span>
        <span>
          <b>Shift</b> sprint
        </span>
        <span>
          <b>Z</b> jockey / shield
        </span>
        <span>
          <b>A</b> pass · hold off the ball to contain
        </span>
        <span>
          <b>S</b> cross · slide tackle
        </span>
        <span>
          <b>Q</b> through ball
        </span>
        <span>
          <b>D</b> shoot · tackle
        </span>
        <span>
          <b>W</b> driven / finesse modifier
        </span>
        <span>
          <b>E</b> lofted / chip modifier · switch player
        </span>
        <span>
          <b>Space / Tab</b> switch player
        </span>
        <span>
          <b>Esc / P</b> pause
        </span>
        <span className="muted">Hold a kick button to charge; double-tap to loft it.</span>
      </footer>
    </div>
  );
}

/** Coarse pointer plus no keyboard is a phone or tablet: warn rather than let them flounder. */
function isProbablyMobile(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(pointer: coarse)').matches &&
    !window.matchMedia?.('(pointer: fine)').matches
  );
}
