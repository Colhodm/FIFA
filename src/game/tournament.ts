/**
 * An eight-team knockout cup, persisted in localStorage. The human's ties are played on the
 * pitch; every CPU-vs-CPU tie is settled by a seeded, rating-weighted coin toss so the
 * bracket is reproducible from its stored seed.
 */
import { mulberry32 } from './sim/math';
import type { TeamData } from './types';

const KEY = 'browser-fifa.cup.v1';

export interface CupTie {
  homeId: string;
  awayId: string;
  homeScore: number | null;
  awayScore: number | null;
  /** Set when the tie needed penalties, purely for display. */
  pens: { home: number; away: number } | null;
  winnerId: string | null;
}

export interface CupState {
  /** The team the human is carrying through the bracket. */
  teamId: string;
  seed: number;
  /** rounds[0] is the quarter-finals; each round halves. */
  rounds: CupTie[][];
  round: number;
  champion: string | null;
  /**
   * Set when the human's tie has been launched but not yet resolved, so a finished match
   * can be matched back to the fixture it belongs to.
   */
  pendingAt: number | null;
}

export function loadCup(): CupState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const cup = JSON.parse(raw) as CupState;
    if (!Array.isArray(cup.rounds)) return null;
    return cup;
  } catch {
    return null;
  }
}

export function saveCup(cup: CupState | null): void {
  try {
    if (cup === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(cup));
  } catch {
    // Storage being unavailable only costs persistence, not the running bracket.
  }
}

/** Draw a fresh eight-team bracket around the human's team. */
export function newCup(teams: TeamData[], teamId: string, seed = Date.now() % 1e9): CupState {
  const rand = mulberry32(seed);
  const others = teams.filter((t) => t.id !== teamId).map((t) => t.id);
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  const entrants = [teamId, ...others.slice(0, 7)];
  for (let i = entrants.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [entrants[i], entrants[j]] = [entrants[j], entrants[i]];
  }
  const ties: CupTie[] = [];
  for (let i = 0; i < 8; i += 2) {
    ties.push({
      homeId: entrants[i],
      awayId: entrants[i + 1],
      homeScore: null,
      awayScore: null,
      pens: null,
      winnerId: null,
    });
  }
  return { teamId, seed, rounds: [ties], round: 0, champion: null, pendingAt: null };
}

/** The human's unresolved tie in the current round, if any. */
export function humanTie(cup: CupState): CupTie | null {
  const round = cup.rounds[cup.round];
  if (!round) return null;
  return (
    round.find(
      (t) => t.winnerId === null && (t.homeId === cup.teamId || t.awayId === cup.teamId),
    ) ?? null
  );
}

/** Settle every unresolved CPU-vs-CPU tie in the current round with a seeded simulation. */
export function resolveCpuTies(cup: CupState, teams: TeamData[]): void {
  const rand = mulberry32(cup.seed + cup.round * 977 + 13);
  for (const tie of cup.rounds[cup.round]) {
    if (tie.winnerId !== null) continue;
    if (tie.homeId === cup.teamId || tie.awayId === cup.teamId) continue;
    const home = teams.find((t) => t.id === tie.homeId);
    const away = teams.find((t) => t.id === tie.awayId);
    const edge = ((home?.rating ?? 75) - (away?.rating ?? 75)) / 40;
    const homeGoals = Math.max(0, Math.round(rand() * 2.6 + edge + rand()));
    const awayGoals = Math.max(0, Math.round(rand() * 2.6 - edge + rand()));
    tie.homeScore = homeGoals;
    tie.awayScore = awayGoals;
    if (homeGoals === awayGoals) {
      const homeWins = rand() < 0.5 + edge * 0.3;
      tie.pens = homeWins
        ? { home: 4 + Math.floor(rand() * 2), away: 3 }
        : { home: 3, away: 4 + Math.floor(rand() * 2) };
      tie.winnerId = homeWins ? tie.homeId : tie.awayId;
    } else {
      tie.winnerId = homeGoals > awayGoals ? tie.homeId : tie.awayId;
    }
  }
}

/** Record the human's finished tie. */
export function resolveHumanTie(
  cup: CupState,
  score: { home: number; away: number },
  pens: { home: number; away: number } | null,
): void {
  const tie = humanTie(cup);
  if (!tie) return;
  tie.homeScore = score.home;
  tie.awayScore = score.away;
  tie.pens = pens;
  const homeWins = pens ? pens.home > pens.away : score.home > score.away;
  tie.winnerId = homeWins ? tie.homeId : tie.awayId;
  cup.pendingAt = null;
}

/** If every tie in the round is settled, build the next round or crown the champion. */
export function advanceCup(cup: CupState): void {
  const round = cup.rounds[cup.round];
  if (!round || round.some((t) => t.winnerId === null)) return;
  if (round.length === 1) {
    cup.champion = round[0].winnerId;
    return;
  }
  const next: CupTie[] = [];
  for (let i = 0; i < round.length; i += 2) {
    next.push({
      homeId: round[i].winnerId as string,
      awayId: round[i + 1].winnerId as string,
      homeScore: null,
      awayScore: null,
      pens: null,
      winnerId: null,
    });
  }
  cup.rounds.push(next);
  cup.round += 1;
}

export const ROUND_NAMES = ['Quarter-finals', 'Semi-finals', 'Final'];
