import { useState } from 'react';
import { audio } from '../game/audio/audio';
import { loadRecords } from '../game/records';
import { teamById, useGameStore } from '../game/store';
import type { TeamData } from '../game/types';
import {
  advanceCup,
  humanTie,
  loadCup,
  newCup,
  resolveCpuTies,
  resolveHumanTie,
  ROUND_NAMES,
  saveCup,
  type CupState,
} from '../game/tournament';

/** Fold any match finished since the cup screen was last open back into the bracket. */
function syncCup(cup: CupState, teams: TeamData[]): CupState {
  const pendingAt = cup.pendingAt;
  if (pendingAt !== null) {
    const tie = humanTie(cup);
    const played = loadRecords().matches.find(
      (m) => m.at >= pendingAt && m.homeTeamId === tie?.homeId && m.awayTeamId === tie?.awayId,
    );
    if (played) {
      resolveHumanTie(cup, played.score, played.shootout);
    } else {
      cup.pendingAt = null;
    }
  }
  // Once the human is out, the rest of the bracket plays itself to a champion.
  while (!cup.champion && cup.rounds[cup.round].every((t) => t.winnerId !== null)) {
    advanceCup(cup);
    if (!cup.champion) {
      resolveCpuTies(cup, teams);
      if (humanTie(cup)) break;
    }
  }
  saveCup(cup);
  return cup;
}

export function Tournament() {
  const teams = useGameStore((s) => s.teams);
  const setup = useGameStore((s) => s.setup);
  const audioEnabled = useGameStore((s) => s.audioEnabled);
  const setScreen = useGameStore((s) => s.setScreen);
  const updateSetup = useGameStore((s) => s.updateSetup);
  const startMatch = useGameStore((s) => s.startMatch);
  const [cup, setCup] = useState<CupState | null>(() => {
    const stored = loadCup();
    return stored ? syncCup(stored, useGameStore.getState().teams) : null;
  });

  const name = (id: string) => teamById(teams, id)?.name ?? id;
  const myTeamId = setup.homeTeamId;

  const startCup = () => {
    if (!myTeamId || teams.length < 8) return;
    const fresh = newCup(teams, myTeamId);
    resolveCpuTies(fresh, teams);
    saveCup(fresh);
    setCup(fresh);
  };

  const playTie = () => {
    if (!cup) return;
    const tie = humanTie(cup);
    if (!tie) return;
    cup.pendingAt = Date.now();
    saveCup(cup);
    const home = teamById(teams, tie.homeId);
    const away = teamById(teams, tie.awayId);
    updateSetup({
      homeTeamId: tie.homeId,
      awayTeamId: tie.awayId,
      homeFormation: home?.formation ?? setup.homeFormation,
      awayFormation: away?.formation ?? setup.awayFormation,
      humanSide: tie.homeId === cup.teamId ? 'home' : 'away',
      mode: 'knockout',
    });
    if (audioEnabled) void audio.resume();
    audio.setEnabled(audioEnabled);
    startMatch();
  };

  const tie = cup ? humanTie(cup) : null;

  return (
    <div className="menu">
      <header className="menu-header">
        <h1>Cup</h1>
        <p>An eight-team knockout — lose and you're out. Progress is saved on this device.</p>
      </header>

      {!cup && (
        <section>
          <p>
            Enter the cup as <b>{name(myTeamId) || 'your selected team'}</b> (pick your team on the
            main menu first).
          </p>
          <button type="button" className="kickoff" disabled={teams.length < 8} onClick={startCup}>
            Start cup
          </button>
        </section>
      )}

      {cup && (
        <div className="records-grid">
          {cup.rounds.map((round, r) => (
            <section key={r}>
              <h2>{ROUND_NAMES[r] ?? `Round ${r + 1}`}</h2>
              <ul className="feed-list">
                {round.map((m, i) => (
                  <li key={i}>
                    {name(m.homeId)}{' '}
                    {m.winnerId !== null ? (
                      <>
                        {m.homeScore}–{m.awayScore} {name(m.awayId)}
                        {m.pens && ` (${m.pens.home}–${m.pens.away} pens)`}
                      </>
                    ) : (
                      <>vs {name(m.awayId)}</>
                    )}
                    {(m.homeId === cup.teamId || m.awayId === cup.teamId) && (
                      <span className="muted"> · you</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {cup?.champion && (
        <p className="result">
          {cup.champion === cup.teamId
            ? `You won the cup with ${name(cup.teamId)}!`
            : `${name(cup.champion)} lifted the cup.`}
        </p>
      )}

      {cup && !cup.champion && !tie && (
        <p className="error">You're out of the cup — but you can always enter a new one.</p>
      )}

      <div className="pill-row">
        {cup && tie && (
          <button type="button" className="kickoff" onClick={playTie}>
            Play your tie: {name(tie.homeId)} vs {name(tie.awayId)}
          </button>
        )}
        {cup && (!tie || cup.champion) && (
          <button
            type="button"
            onClick={() => {
              saveCup(null);
              setCup(null);
            }}
          >
            New cup
          </button>
        )}
        <button type="button" onClick={() => setScreen('menu')}>
          Back
        </button>
      </div>
    </div>
  );
}
