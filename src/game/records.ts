/**
 * Local match history and career records, persisted in localStorage. Everything is optional:
 * a blocked or full store degrades to an empty book, never an error.
 */
import { matchRating, type SimWorld } from './sim/state';
import type { MatchMode, TeamSide } from './types';

const KEY = 'browser-fifa.records.v1';
const MAX_MATCHES = 200;

export interface MatchRecord {
  /** Epoch ms when the final whistle went. */
  at: number;
  mode: MatchMode;
  homeTeamId: string;
  awayTeamId: string;
  homeName: string;
  awayName: string;
  score: Record<TeamSide, number>;
  shootout: Record<TeamSide, number> | null;
  humanSide: TeamSide;
  difficulty: string;
  /** From the human player's point of view. */
  result: 'win' | 'draw' | 'loss';
}

export interface PlayerRecord {
  name: string;
  teamId: string;
  apps: number;
  goals: number;
  /** Sum of match ratings; divide by apps for the average. */
  ratingSum: number;
}

export interface RecordBook {
  matches: MatchRecord[];
  /** Keyed by `${teamId}:${name}`. */
  players: Record<string, PlayerRecord>;
}

const empty = (): RecordBook => ({ matches: [], players: {} });

export function loadRecords(): RecordBook {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const book = JSON.parse(raw) as RecordBook;
    if (!Array.isArray(book.matches) || typeof book.players !== 'object') return empty();
    return book;
  } catch {
    return empty();
  }
}

function saveRecords(book: RecordBook): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(book));
  } catch {
    // Private browsing or a full quota: records are a luxury, not a requirement.
  }
}

export function clearRecords(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Ignore.
  }
}

/** Fold a finished match into the book: the result line plus every player's contribution. */
export function recordMatch(world: SimWorld): MatchRecord {
  const config = world.config;
  const human = config.humanSide;
  const cpu: TeamSide = human === 'home' ? 'away' : 'home';
  const shootout = world.shootout;
  const winner: TeamSide | null = shootout?.winner
    ? shootout.winner
    : world.score.home === world.score.away
      ? null
      : world.score.home > world.score.away
        ? 'home'
        : 'away';
  const match: MatchRecord = {
    at: Date.now(),
    mode: config.mode ?? 'friendly',
    homeTeamId: config.homeTeam.id,
    awayTeamId: config.awayTeam.id,
    homeName: config.homeTeam.name,
    awayName: config.awayTeam.name,
    score: { ...world.score },
    shootout: shootout ? { ...shootout.scores } : null,
    humanSide: human,
    difficulty: config.difficulty,
    result: winner === null ? 'draw' : winner === human ? 'win' : winner === cpu ? 'loss' : 'draw',
  };

  const book = loadRecords();
  book.matches.unshift(match);
  book.matches.length = Math.min(book.matches.length, MAX_MATCHES);
  for (const p of world.players) {
    const teamId = p.side === 'home' ? config.homeTeam.id : config.awayTeam.id;
    const key = `${teamId}:${p.name}`;
    const entry = book.players[key] ?? { name: p.name, teamId, apps: 0, goals: 0, ratingSum: 0 };
    entry.apps += 1;
    entry.goals += p.tally.goals;
    entry.ratingSum += matchRating(p);
    book.players[key] = entry;
  }
  saveRecords(book);
  return match;
}

export interface RecordTotals {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  scored: number;
  conceded: number;
}

/** Human-perspective totals across every stored match. */
export function totals(book: RecordBook): RecordTotals {
  const t: RecordTotals = { played: 0, wins: 0, draws: 0, losses: 0, scored: 0, conceded: 0 };
  for (const m of book.matches) {
    const cpu: TeamSide = m.humanSide === 'home' ? 'away' : 'home';
    t.played += 1;
    if (m.result === 'win') t.wins += 1;
    else if (m.result === 'draw') t.draws += 1;
    else t.losses += 1;
    t.scored += m.score[m.humanSide];
    t.conceded += m.score[cpu];
  }
  return t;
}

/** Top scorers across the book, best first. */
export function topScorers(book: RecordBook, limit = 10): PlayerRecord[] {
  return Object.values(book.players)
    .filter((p) => p.goals > 0)
    .sort((a, b) => b.goals - a.goals || b.ratingSum / b.apps - a.ratingSum / a.apps)
    .slice(0, limit);
}

/** Best average ratings among players with a few appearances, best first. */
export function topRated(book: RecordBook, limit = 10): PlayerRecord[] {
  return Object.values(book.players)
    .filter((p) => p.apps >= 3)
    .sort((a, b) => b.ratingSum / b.apps - a.ratingSum / a.apps)
    .slice(0, limit);
}
