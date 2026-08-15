import {
  TICK_DT,
  BALL_RADIUS,
  GOAL_HEIGHT,
  HALF_GOAL_WIDTH,
  HALF_LENGTH,
  HALF_WIDTH,
  PENALTY_BOX_DEPTH,
  PENALTY_BOX_WIDTH,
  PENALTY_SPOT_DISTANCE,
  WALL_DISTANCE,
} from '../constants';
import type { TeamSide } from '../types';
import { nearestOf } from './ai';
import { goalCenter, ownGoalCenter } from './kick';
import { clamp, dist, normalize, sub, type Vec2 } from './math';
import {
  onPitch,
  resetToKickoff,
  teamOf,
  type FeedEntry,
  type RestartKind,
  type SimPlayer,
  type SimWorld,
} from './state';

const other = (side: TeamSide): TeamSide => (side === 'home' ? 'away' : 'home');

/** Side attacking towards +x / -x. */
function sideAttacking(world: SimWorld, dir: 1 | -1): TeamSide {
  return world.attackDir.home === dir ? 'home' : 'away';
}

export function stopBall(world: SimWorld, spot: Vec2): void {
  world.ball.pos = { x: spot.x, y: BALL_RADIUS, z: spot.z };
  world.ball.vel = { x: 0, y: 0, z: 0 };
  world.ball.spin = { x: 0, y: 0, z: 0 };
  world.commands.push({ type: 'teleport', pos: { x: spot.x, y: BALL_RADIUS, z: spot.z } });
}

export function pushFeed(world: SimWorld, entry: Omit<FeedEntry, 'minute'>): void {
  world.feed.push({ minute: matchMinute(world), ...entry });
  if (world.feed.length > 40) world.feed.shift();
}

const BANNERS: Record<RestartKind, string> = {
  'throw-in': 'Throw-in',
  'goal-kick': 'Goal kick',
  corner: 'Corner kick',
  'free-kick': 'Free kick',
  penalty: 'Penalty!',
};

/** Seconds a side gets to line up before the taker may play the ball. */
const PREPARE: Record<RestartKind, number> = {
  'throw-in': 0.7,
  'goal-kick': 1,
  corner: 1.4,
  'free-kick': 1.6,
  penalty: 2,
};

export function setupRestart(world: SimWorld, kind: RestartKind, side: TeamSide, spot: Vec2): void {
  stopBall(world, spot);
  const taker =
    kind === 'goal-kick'
      ? (onPitch(world).find((p) => p.side === side && p.role === 'GK') ?? null)
      : nearestOf(world, spot, side);
  if (taker) {
    const inward = { x: -Math.sign(spot.x) * 1.2, z: -Math.sign(spot.z) * 1.2 };
    taker.pos = { x: spot.x + inward.x, z: spot.z + inward.z };
    taker.vel = { x: 0, z: 0 };
    taker.kickCooldown = 0;
    taker.heading = Math.atan2(spot.x - taker.pos.x, spot.z - taker.pos.z);
    if (side === world.config.humanSide && (taker.role !== 'GK' || kind === 'goal-kick')) {
      world.activeId = taker.id;
    }
  }
  world.restart = {
    kind,
    side,
    spot,
    takerId: taker?.id ?? -1,
    prepare: PREPARE[kind],
    autoTake: PREPARE[kind] + 1.2 + world.rand() * 0.8,
  };
  world.phase = 'restart';
  world.phaseTimer = PREPARE[kind];
  world.possession = side;
  world.controllerId = null;
  world.offsideActive = kind === 'free-kick' || kind === 'penalty';
  world.banner = BANNERS[kind];
  world.events.push({ type: 'out', side });
  for (const p of world.players) p.offside = false;
  if (kind === 'free-kick') buildWall(world, side, spot);
  if (kind === 'penalty') setPenaltyPositions(world, side, spot);
  if (kind === 'corner') world.stats[side].corners += 1;
}

/** Three defenders ten yards from the ball, on the line between it and their own goal. */
function buildWall(world: SimWorld, attacking: TeamSide, spot: Vec2): void {
  const defending = other(attacking);
  const own = ownGoalCenter(world, defending);
  if (dist(spot, own) > 34) return;
  const toGoal = normalize(sub(own, spot));
  const across = { x: -toGoal.z, z: toGoal.x };
  const wallSpot = { x: spot.x + toGoal.x * WALL_DISTANCE, z: spot.z + toGoal.z * WALL_DISTANCE };
  const wall = onPitch(world)
    .filter((p) => p.side === defending && p.role !== 'GK')
    .sort((a, b) => dist(a.pos, wallSpot) - dist(b.pos, wallSpot))
    .slice(0, 3);
  wall.forEach((p, i) => {
    const offset = (i - 1) * 0.85;
    p.pos = { x: wallSpot.x + across.x * offset, z: wallSpot.z + across.z * offset };
    p.vel = { x: 0, z: 0 };
    p.heading = Math.atan2(spot.x - p.pos.x, spot.z - p.pos.z);
    // The wall holds its ground until the kick is taken.
    p.kickCooldown = Math.max(p.kickCooldown, 0.4);
  });
}

/** Everyone but the taker and the keeper clears the box for a penalty. */
function setPenaltyPositions(world: SimWorld, attacking: TeamSide, spot: Vec2): void {
  const defending = other(attacking);
  const goal = goalCenter(world, attacking);
  const dir = world.attackDir[attacking];
  const takerId = world.restart?.takerId ?? -1;
  let n = 0;
  for (const p of onPitch(world)) {
    if (p.id === takerId) {
      p.pos = { x: spot.x - dir * 2.2, z: spot.z };
      p.heading = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      continue;
    }
    if (p.role === 'GK') {
      if (p.side === defending) {
        p.pos = { x: goal.x - dir * 0.2, z: 0 };
        p.heading = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
      }
      continue;
    }
    // Line the rest up on the edge of the box, alternating sides.
    const lane = ((n % 6) - 2.5) * 3.4;
    p.pos = {
      x: goal.x - dir * (PENALTY_BOX_DEPTH + 2 + (n > 5 ? 3 : 0)),
      z: clamp(lane, -PENALTY_BOX_WIDTH / 2, PENALTY_BOX_WIDTH / 2),
    };
    p.vel = { x: 0, z: 0 };
    p.heading = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    n += 1;
  }
}

/** Goal, throw-in, corner and goal-kick detection. Returns true when play was interrupted. */
export function checkBallOut(world: SimWorld): boolean {
  const { x, y, z } = world.ball.pos;

  if (Math.abs(x) > HALF_LENGTH + BALL_RADIUS) {
    const dir: 1 | -1 = x > 0 ? 1 : -1;
    const scorer = sideAttacking(world, dir);
    const defender = other(scorer);
    /*
     * Test where the ball crossed the goal line, not where it happens to be now.
     *
     * A shot at a hundred miles an hour covers three quarters of a metre per tick, so sampling
     * the instantaneous position caught the ball *behind* the goal — and if it was within the
     * posts and under the bar at that sampled instant it counted as a goal, even when it had
     * actually passed wide of the post or over the bar and come down beyond it. That is the
     * phantom goal that dropped matches back to kickoff for no visible reason.
     */
    const line = HALF_LENGTH * dir;
    const back = {
      x: x - world.ball.vel.x * TICK_DT,
      y: y - world.ball.vel.y * TICK_DT,
      z: z - world.ball.vel.z * TICK_DT,
    };
    const span = x - back.x;
    // If it did not travel across the line this tick, judge it where it is.
    const f = Math.abs(span) < 1e-6 ? 1 : clamp((line - back.x) / span, 0, 1);
    const crossZ = back.z + (z - back.z) * f;
    const crossY = back.y + (y - back.y) * f;
    const isGoal = Math.abs(crossZ) < HALF_GOAL_WIDTH - BALL_RADIUS && crossY < GOAL_HEIGHT;
    if (isGoal) {
      scoreGoal(world, scorer);
      return true;
    }
    const lastSide = world.lastTouch?.side ?? scorer;
    if (lastSide === scorer) {
      setupRestart(world, 'goal-kick', defender, {
        x: (HALF_LENGTH - PENALTY_BOX_DEPTH + 5) * dir,
        z: clamp(z, -12, 12),
      });
    } else {
      setupRestart(world, 'corner', scorer, {
        x: (HALF_LENGTH - 0.6) * dir,
        z: Math.sign(z || 1) * (HALF_WIDTH - 0.6),
      });
    }
    return true;
  }

  if (Math.abs(z) > HALF_WIDTH + BALL_RADIUS) {
    const lastSide = world.lastTouch?.side ?? 'home';
    setupRestart(world, 'throw-in', other(lastSide), {
      x: clamp(x, -HALF_LENGTH + 2, HALF_LENGTH - 2),
      z: Math.sign(z) * (HALF_WIDTH - 0.3),
    });
    return true;
  }

  return false;
}

export function scoreGoal(world: SimWorld, side: TeamSide): void {
  world.score[side] += 1;
  world.lastScorer = side;
  const scorer = world.players.find((p) => p.id === world.lastTouch?.playerId);
  world.lastScorerId = scorer && scorer.side === side ? scorer.id : null;
  world.phase = 'goal';
  world.phaseTimer = 5.5;
  world.possession = null;
  world.controllerId = null;
  world.stoppage += 2.5;
  const team = teamOf(world, side);
  world.banner = `GOAL! ${team.name}`;
  pushFeed(world, {
    kind: 'goal',
    side,
    text: scorer ? `${scorer.name} scores for ${team.shortName}` : `${team.name} score`,
  });
  world.events.push({ type: 'goal', side, intensity: 1 });
  world.events.push({ type: 'whistle', intensity: 0.6 });
  if (scorer && scorer.side === side) {
    scorer.tally.goals += 1;
    scorer.anim = 'celebrate';
    scorer.animTimer = 5;
  }
}

/**
 * Offside is judged the moment a teammate plays the ball: anyone ahead of both the ball and
 * the second-last defender is flagged, and is only penalised if he then touches it.
 */
export function flagOffsides(world: SimWorld, passer: SimPlayer): void {
  for (const p of world.players) p.offside = false;
  if (!world.offsideActive) return;
  const attack = world.attackDir[passer.side];
  const opponents = onPitch(world)
    .filter((p) => p.side !== passer.side)
    .map((p) => p.pos.x * attack)
    .sort((a, b) => b - a);
  // Second-last defender, i.e. usually the last outfield man with the keeper behind him.
  const line = Math.max(opponents[1] ?? -HALF_LENGTH, 0);
  const ballLine = world.ball.pos.x * attack;
  for (const mate of onPitch(world)) {
    if (mate.side !== passer.side || mate.id === passer.id) continue;
    const ahead = mate.pos.x * attack;
    if (ahead > line + 0.4 && ahead > ballLine + 0.4) mate.offside = true;
  }
}

/** Called when a flagged player touches the ball: indirect free kick the other way. */
export function whistleOffside(world: SimWorld, player: SimPlayer): void {
  const against = player.side;
  world.stats[against].offsides += 1;
  world.stoppage += 1;
  pushFeed(world, { kind: 'offside', side: against, text: `${player.name} is offside` });
  world.events.push({ type: 'offside', side: against });
  world.events.push({ type: 'whistle', intensity: 0.45 });
  setupRestart(world, 'free-kick', other(against), {
    x: clamp(player.pos.x, -HALF_LENGTH + 6, HALF_LENGTH - 6),
    z: clamp(player.pos.z, -HALF_WIDTH + 3, HALF_WIDTH - 3),
  });
  world.banner = 'Offside';
}

export interface FoulOptions {
  /** 0..1: how reckless the challenge was, driving the chance of a card. */
  severity: number;
}

/**
 * A foul stops play. Inside the offender's own box it is a penalty; a challenge that wipes out
 * a clear run on goal is a straight red, otherwise the referee reaches for the yellow.
 */
export function awardFoul(
  world: SimWorld,
  offender: SimPlayer,
  victim: SimPlayer,
  options: FoulOptions,
): void {
  const attacking = victim.side;
  const spot = {
    x: clamp(victim.pos.x, -HALF_LENGTH + 1, HALF_LENGTH - 1),
    z: clamp(victim.pos.z, -HALF_WIDTH + 1, HALF_WIDTH - 1),
  };
  world.stats[offender.side].fouls += 1;
  offender.tally.fouls += 1;
  world.stoppage += 1.2;
  world.events.push({ type: 'foul', side: offender.side, intensity: options.severity });
  world.events.push({ type: 'whistle', intensity: 0.5 });

  const ownGoal = ownGoalCenter(world, offender.side);
  const inBox =
    Math.abs(spot.x - ownGoal.x) < PENALTY_BOX_DEPTH &&
    Math.abs(spot.z) < PENALTY_BOX_WIDTH / 2 &&
    offender.role !== 'GK';
  const goalDenied = clearChance(world, victim) && options.severity > 0.45;

  if (goalDenied) sendOff(world, offender, 'denying a clear goalscoring chance');
  else if (options.severity > 0.55 || (inBox && options.severity > 0.35)) book(world, offender);

  pushFeed(world, {
    kind: 'foul',
    side: offender.side,
    text: `${offender.name} fouls ${victim.name}`,
  });
  // The fouled man goes down; the offender stays on his feet but out of the next play.
  victim.anim = 'down';
  victim.animTimer = 1.6;
  victim.vel = { x: 0, z: 0 };
  offender.kickCooldown = Math.max(offender.kickCooldown, 1);

  if (inBox) {
    const dir = world.attackDir[attacking];
    setupRestart(world, 'penalty', attacking, {
      x: goalCenter(world, attacking).x - dir * PENALTY_SPOT_DISTANCE,
      z: 0,
    });
    return;
  }
  setupRestart(world, 'free-kick', attacking, spot);
}

/** Was the fouled player through on goal with nothing but the keeper ahead of him? */
function clearChance(world: SimWorld, victim: SimPlayer): boolean {
  const goal = goalCenter(world, victim.side);
  if (dist(victim.pos, goal) > 34) return false;
  const attack = world.attackDir[victim.side];
  const ahead = onPitch(world).filter(
    (p) => p.side !== victim.side && p.role !== 'GK' && p.pos.x * attack > victim.pos.x * attack,
  );
  return ahead.length === 0;
}

export function book(world: SimWorld, player: SimPlayer): void {
  player.yellowCards += 1;
  if (player.yellowCards >= 2) {
    sendOff(world, player, 'a second bookable offence');
    return;
  }
  world.stats[player.side].yellows += 1;
  world.events.push({ type: 'card', side: player.side, intensity: 0.4, text: 'yellow' });
  pushFeed(world, { kind: 'card', side: player.side, text: `${player.name} is booked` });
}

export function sendOff(world: SimWorld, player: SimPlayer, reason: string): void {
  if (player.sentOff) return;
  player.sentOff = true;
  player.vel = { x: 0, z: 0 };
  world.stats[player.side].reds += 1;
  world.events.push({ type: 'card', side: player.side, intensity: 1, text: 'red' });
  pushFeed(world, { kind: 'card', side: player.side, text: `${player.name} sent off: ${reason}` });
  if (world.controllerId === player.id) world.controllerId = null;
  if (world.activeId === player.id) {
    const replacement = onPitch(world).find((p) => p.side === player.side && p.role !== 'GK');
    if (replacement) world.activeId = replacement.id;
  }
}

/** When the current half ends: regulation time plus however much stoppage has accrued. */
export function halfEndsAt(world: SimWorld): number {
  return world.config.halfLength + Math.min(world.stoppage, world.config.halfLength * 0.15);
}

/** Advances the half clock and drives half-time / full-time transitions. */
export function advanceClock(world: SimWorld, dt: number): void {
  world.clock += dt;
  const full = halfEndsAt(world);
  if (world.clock < full) return;
  world.clock = full;
  if (world.half === 1) {
    world.phase = 'halftime';
    world.phaseTimer = 6;
    world.banner = 'Half time';
    world.events.push({ type: 'halftime' });
    world.events.push({ type: 'whistle', intensity: 0.8 });
  } else {
    world.phase = 'end';
    world.phaseTimer = 0;
    world.banner = 'Full time';
    world.events.push({ type: 'fulltime' });
    world.events.push({ type: 'whistle', intensity: 1 });
  }
}

export function startSecondHalf(world: SimWorld): void {
  world.half = 2;
  world.clock = 0;
  world.stoppage = 0;
  world.attackDir = { home: world.attackDir.away, away: world.attackDir.home };
  resetToKickoff(world, other(world.kickoffSide));
  world.banner = 'Second half';
  world.events.push({ type: 'kickoff' });
}

/** Match minute shown on the HUD: each half maps onto 45 minutes. */
export function matchMinute(world: SimWorld): number {
  const progress = clamp(world.clock / world.config.halfLength, 0, 1);
  return Math.floor((world.half - 1) * 45 + progress * 45);
}

/** Minutes of added time being played, or 0 in normal time. */
export function stoppageMinutes(world: SimWorld): number {
  if (world.clock <= world.config.halfLength) return 0;
  const extra = (world.clock - world.config.halfLength) / world.config.halfLength;
  return Math.max(1, Math.ceil(extra * 45));
}
