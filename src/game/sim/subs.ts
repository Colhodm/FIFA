import { FORMATIONS } from '../formations';
import type { FormationId, PlayerData, TeamSide } from '../types';
import { pushFeed } from './rules';
import { emptyTally, teamOf, type SimWorld } from './state';

/** Substitutions allowed per side, per match. */
export const MAX_SUBS = 5;

export interface BenchEntry {
  /** Index into the team's players array. */
  index: number;
  data: PlayerData;
}

/** Squad players who started on the bench and have not yet come on. */
export function benchFor(world: SimWorld, side: TeamSide): BenchEntry[] {
  const team = teamOf(world, side);
  const starters = world.players.filter((p) => p.side === side).length;
  return team.players
    .map((data, index) => ({ index, data }))
    .slice(starters)
    .filter((entry) => !world.benchUsed[side].includes(entry.index));
}

/** Whether this substitution is currently allowed to be queued. */
export function canSub(
  world: SimWorld,
  side: TeamSide,
  outId: number,
  benchIndex: number,
): boolean {
  if (world.phase === 'end') return false;
  const queued = world.pendingSubs.filter((s) => s.side === side).length;
  if (world.subsUsed[side] + queued >= MAX_SUBS) return false;
  const out = world.players.find((p) => p.id === outId);
  if (!out || out.side !== side || out.sentOff) return false;
  if (
    world.pendingSubs.some(
      (s) => s.outId === outId || (s.side === side && s.benchIndex === benchIndex),
    )
  )
    return false;
  const entry = benchFor(world, side).find((b) => b.index === benchIndex);
  if (!entry) return false;
  // Keepers replace keepers; outfield players replace outfield players.
  return (out.role === 'GK') === (entry.data.role === 'GK');
}

/** Queues a substitution; it happens at the next dead ball. */
export function requestSub(
  world: SimWorld,
  side: TeamSide,
  outId: number,
  benchIndex: number,
): boolean {
  if (!canSub(world, side, outId, benchIndex)) return false;
  world.pendingSubs.push({ side, outId, benchIndex });
  return true;
}

/**
 * The board goes up. The outgoing man's shirt, stats and freshness are replaced in place, so
 * every id-keyed system — switching, control, rendering — carries straight on. Cards and the
 * match tally belong to the person, not the shirt, so they reset.
 */
export function applyPendingSubs(world: SimWorld): void {
  if (world.pendingSubs.length === 0) return;
  for (const sub of world.pendingSubs) {
    const out = world.players.find((p) => p.id === sub.outId);
    const data = teamOf(world, sub.side).players[sub.benchIndex];
    if (!out || !data || out.sentOff) continue;
    const offName = out.name;
    out.name = data.name;
    out.shirt = data.shirt;
    out.index = sub.benchIndex;
    out.pace = data.stats.pace;
    out.shooting = data.stats.shooting;
    out.passing = data.stats.passing;
    out.dribbling = data.stats.dribbling;
    out.defending = data.stats.defending;
    out.physical = data.stats.physical;
    out.enduranceRating = data.stats.stamina;
    out.stamina = 1;
    out.balance = 1;
    out.yellowCards = 0;
    out.tally = emptyTally();
    out.plannedShot = null;
    out.holdTimer = 0;
    out.skillTimer = 0;
    world.subsUsed[sub.side] += 1;
    world.benchUsed[sub.side].push(sub.benchIndex);
    pushFeed(world, {
      kind: 'note',
      side: sub.side,
      text: `Sub: ${data.name} on for ${offName}`,
    });
    world.events.push({ type: 'whistle', intensity: 0.3 });
  }
  world.pendingSubs = [];
}

/**
 * The CPU manages its own bench: from the hour mark it replaces anyone running on empty with
 * the freshest same-position man it has left.
 */
export function maybeAutoSub(world: SimWorld): void {
  const cpu: TeamSide = world.config.humanSide === 'home' ? 'away' : 'home';
  if (world.half < 2 || world.clock < world.config.halfLength * 0.35) return;
  if (world.subsUsed[cpu] + world.pendingSubs.filter((s) => s.side === cpu).length >= MAX_SUBS)
    return;
  const tired = world.players
    .filter(
      (p) =>
        p.side === cpu &&
        p.role !== 'GK' &&
        !p.sentOff &&
        p.stamina < 0.28 &&
        !world.pendingSubs.some((s) => s.outId === p.id),
    )
    .sort((a, b) => a.stamina - b.stamina)[0];
  if (!tired) return;
  const bench = benchFor(world, cpu).filter((b) => b.data.role !== 'GK');
  const like = bench.find((b) => b.data.role === tired.slotRole) ?? bench[0];
  if (like) requestSub(world, cpu, tired.id, like.index);
}

/** Queues a formation change; the shape is redrawn at the next dead ball. */
export function requestFormation(world: SimWorld, side: TeamSide, id: FormationId): void {
  const current = side === 'home' ? world.config.homeFormation : world.config.awayFormation;
  if (id === current && !world.pendingFormations[side]) return;
  world.pendingFormations[side] = id;
}

/** Reassigns every player's formation slot, in squad order, to the new shape. */
export function applyPendingFormations(world: SimWorld): void {
  for (const side of ['home', 'away'] as TeamSide[]) {
    const id = world.pendingFormations[side];
    if (!id) continue;
    const slots = FORMATIONS[id].slots;
    const players = world.players.filter((p) => p.side === side).sort((a, b) => a.id - b.id);
    players.forEach((p, i) => {
      const slot = slots[i] ?? slots[slots.length - 1];
      p.slot = { x: slot.x, z: slot.z };
      p.slotRole = slot.role;
    });
    if (side === 'home') world.config.homeFormation = id;
    else world.config.awayFormation = id;
    pushFeed(world, { kind: 'note', side, text: `Formation change: ${id}` });
    delete world.pendingFormations[side];
  }
}

/** A substitution may only be made while the ball is dead. */
export const subWindowOpen = (world: SimWorld): boolean =>
  world.phase === 'kickoff' ||
  world.phase === 'halftime' ||
  world.phase === 'goal' ||
  (world.phase === 'restart' && world.restart !== null);
