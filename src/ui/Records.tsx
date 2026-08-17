import { useState } from 'react';
import { clearRecords, loadRecords, topRated, topScorers, totals } from '../game/records';
import { teamById, useGameStore } from '../game/store';

export function Records() {
  const teams = useGameStore((s) => s.teams);
  const setScreen = useGameStore((s) => s.setScreen);
  const [book, setBook] = useState(loadRecords);
  const t = totals(book);
  const scorers = topScorers(book, 10);
  const rated = topRated(book, 10);
  const shortName = (teamId: string) => teamById(teams, teamId)?.shortName ?? teamId;

  return (
    <div className="menu">
      <header className="menu-header">
        <h1>Records</h1>
        <p>Every match you finish is saved on this device.</p>
      </header>

      <div className="records-grid">
        <section>
          <h2>Your career</h2>
          <table className="records-table">
            <tbody>
              <tr>
                <td>Played</td>
                <td>{t.played}</td>
              </tr>
              <tr>
                <td>Won / drawn / lost</td>
                <td>
                  {t.wins} / {t.draws} / {t.losses}
                </td>
              </tr>
              <tr>
                <td>Goals for / against</td>
                <td>
                  {t.scored} / {t.conceded}
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section>
          <h2>Top scorers</h2>
          {scorers.length === 0 && <p className="muted">No goals recorded yet.</p>}
          <table className="records-table">
            <tbody>
              {scorers.map((p) => (
                <tr key={`${p.teamId}:${p.name}`}>
                  <td>
                    {p.name} <span className="muted">({shortName(p.teamId)})</span>
                  </td>
                  <td>
                    {p.goals} in {p.apps}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h2>Best rated (3+ games)</h2>
          {rated.length === 0 && <p className="muted">Play a few matches to build ratings.</p>}
          <table className="records-table">
            <tbody>
              {rated.map((p) => (
                <tr key={`${p.teamId}:${p.name}`}>
                  <td>
                    {p.name} <span className="muted">({shortName(p.teamId)})</span>
                  </td>
                  <td>{(p.ratingSum / p.apps).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h2>Recent matches</h2>
          {book.matches.length === 0 && <p className="muted">No matches yet — go play one.</p>}
          <ul className="feed-list">
            {book.matches.slice(0, 12).map((m) => (
              <li key={m.at}>
                <span className={`fd-min result-${m.result}`}>{m.result.toUpperCase()}</span>{' '}
                {m.homeName} {m.score.home}–{m.score.away} {m.awayName}
                {m.shootout && ` (${m.shootout.home}–${m.shootout.away} pens)`}
                <span className="muted"> · {m.mode}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="pill-row">
        <button type="button" onClick={() => setScreen('menu')}>
          Back
        </button>
        {book.matches.length > 0 && (
          <button
            type="button"
            onClick={() => {
              clearRecords();
              setBook(loadRecords());
            }}
          >
            Clear records
          </button>
        )}
      </div>
    </div>
  );
}
