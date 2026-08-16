import {
  HALF_GOAL_WIDTH,
  HALF_LENGTH,
  BASE_SPEED,
  CENTER_CIRCLE_RADIUS,
  HALF_WIDTH,
  MAX_PASS_POWER,
  MAX_SHOT_POWER,
  MIN_PASS_POWER,
  MIN_SHOT_POWER,
} from '../constants';
import {
  applyKick,
  ballPos2,
  bestPass,
  bestThroughBall,
  curlToward,
  goalCenter,
  ownGoalCenter,
  shotQuality,
} from './kick';
import { strike, type ShotStyle } from './finishing';
import { distToSegment, clamp, dist, normalize, sub, type Vec2 } from './math';
import { slotToPitch, type DifficultyProfile, type SimPlayer, type SimWorld } from './state';

const EDGE = 1.5;

/** The retreat the laws require at a free kick or corner. */
const TEN_YARDS = 9.15;

const clampToPitch = (p: Vec2): Vec2 => ({
  x: clamp(p.x, -HALF_LENGTH + EDGE, HALF_LENGTH - EDGE),
  z: clamp(p.z, -HALF_WIDTH + EDGE, HALF_WIDTH - EDGE),
});

/** Nearest player of a side to a point, optionally skipping the goalkeeper. */
export function nearestOf(
  world: SimWorld,
  point: Vec2,
  side: SimPlayer['side'],
  skipKeeper = true,
  exclude = -1,
): SimPlayer | null {
  let best: SimPlayer | null = null;
  let bestD = Infinity;
  for (const p of world.players) {
    if (p.side !== side || p.id === exclude || p.sentOff) continue;
    if (skipKeeper && p.role === 'GK') continue;
    const d = dist(p.pos, point);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

export function nearestOpponentDistance(world: SimWorld, p: SimPlayer): number {
  let best = Infinity;
  for (const o of world.players) {
    if (o.side === p.side || o.sentOff) continue;
    best = Math.min(best, dist(o.pos, p.pos));
  }
  return best;
}

/** Where the ball will be shortly — used so chasers cut it off instead of trailing it. */
function interceptPoint(world: SimWorld, lead = 0.35): Vec2 {
  return {
    x: world.ball.pos.x + world.ball.vel.x * lead,
    z: world.ball.pos.z + world.ball.vel.z * lead,
  };
}

/** Formation shape position for a player, shifted by ball position and phase of play. */
function shapeTarget(world: SimWorld, p: SimPlayer): Vec2 {
  const dir = world.attackDir[p.side];
  const base = slotToPitch(p.slot, dir);
  const ball = ballPos2(world);
  const attacking = world.possession === p.side;
  const push = attacking ? 9 : -4;
  const line = p.slotRole === 'DF' ? 0.5 : p.slotRole === 'FW' ? 1.1 : 0.8;
  return clampToPitch({
    x: base.x + clamp(ball.x * 0.45, -20, 20) + push * dir * line,
    z: base.z + clamp((ball.z - base.z) * 0.35, -13, 13),
  });
}

/**
 * How dangerous an attacker is to us right now. Higher is worse.
 *
 * The old marking picked whoever was simply *nearest*, so a centre-half would dutifully track a
 * midfielder drifting past him while a striker ran in behind completely free. Danger is about
 * where a man is going, not how close he happens to be.
 */
function threatOf(world: SimWorld, p: SimPlayer, attacker: SimPlayer): number {
  const own = ownGoalCenter(world, p.side);
  const toGoal = normalize(sub(own, attacker.pos));
  const range = dist(attacker.pos, own);
  // Running at our goal is the thing that hurts; standing still near it is much less urgent.
  const closing = attacker.vel.x * toGoal.x + attacker.vel.z * toGoal.z;
  // Central runners are worse than wide ones.
  const centrality = 1 - Math.min(1, Math.abs(attacker.pos.z) / HALF_WIDTH);
  return -range * 0.7 + closing * 4.2 + centrality * 8 - dist(attacker.pos, p.pos) * 0.25;
}

/**
 * Who this defender is responsible for, and where he should stand to deny him.
 *
 * Assignment is greedy over the whole back unit in a fixed order, so two defenders never end up
 * tracking the same man while a third attacker runs through the gap between them — which the old
 * nearest-man rule allowed constantly.
 */
function markTarget(world: SimWorld, p: SimPlayer, profile: DifficultyProfile): Vec2 | null {
  const own = ownGoalCenter(world, p.side);
  const attackers = world.players
    .filter((o) => o.side !== p.side && o.role !== 'GK' && !o.sentOff)
    .sort((a, b) => a.id - b.id);
  const defenders = world.players
    .filter((o) => o.side === p.side && o.role !== 'GK' && !o.sentOff)
    .sort((a, b) => a.id - b.id);

  // Deal the most dangerous attacker to the defender best placed to take him, then the next.
  const taken = new Set<number>();
  let mine: SimPlayer | null = null;
  const ranked = attackers
    .map((o) => ({ o, threat: threatOf(world, p, o) }))
    .sort((x, y) => y.threat - x.threat);
  for (const d of defenders) {
    let pick: SimPlayer | null = null;
    let bestScore = -Infinity;
    for (const { o } of ranked) {
      if (taken.has(o.id)) continue;
      // Threat as *this* defender sees it, minus how far he has to travel to get there.
      const score = threatOf(world, d, o) - dist(d.pos, o.pos) * 0.55;
      if (score > bestScore) {
        bestScore = score;
        pick = o;
      }
    }
    if (!pick) break;
    taken.add(pick.id);
    if (d.id === p.id) {
      mine = pick;
      break;
    }
  }
  if (!mine) return null;
  // Too far away to be his problem; hold the shape instead.
  if (dist(mine.pos, p.pos) > 26) return null;

  /*
   * Track where he is *going*. Marking his current position leaves a defender permanently
   * trailing a runner by whatever he covers in the reaction time, which is exactly how strikers
   * were getting in behind untouched.
   */
  const lead = 0.55;
  const spot = { x: mine.pos.x + mine.vel.x * lead, z: mine.pos.z + mine.vel.z * lead };
  const goalSide = normalize(sub(own, spot));
  // Tighten right up as the danger rises: close to our goal, and on a man breaking in behind.
  const danger = clamp(1 - dist(spot, own) / 45, 0, 1);
  const breaking = clamp(
    (mine.vel.x * goalSide.x + mine.vel.z * goalSide.z) / Math.max(1, BASE_SPEED),
    0,
    1,
  );
  const slack = (1 - profile.marking) * 2.6 * (1 - danger * 0.6);
  const gap = clamp(1.0 + slack - breaking * 0.5, 0.7, 4);
  return clampToPitch({ x: spot.x + goalSide.x * gap, z: spot.z + goalSide.z * gap });
}

function setIntent(p: SimPlayer, target: Vec2, sprint: boolean, face: Vec2 | null = null): void {
  const to = sub(target, p.pos);
  const d = Math.hypot(to.x, to.z);
  // Ease off near the target so players settle instead of jittering.
  const throttle = clamp(d / 2.5, 0, 1);
  const n = normalize(to);
  p.intent = { x: n.x * throttle, z: n.z * throttle };
  p.intentFace = face;
  p.intentSprint = sprint && d > 5;
}

/** Off-ball decision for one AI player. Called on the reaction-time cadence. */
export function decideOffBall(world: SimWorld, p: SimPlayer, profile: DifficultyProfile): void {
  if (p.role === 'GK') {
    /*
     * Rush: the human has called his keeper out. He goes for the ball rather than his line, but
     * only within a sane range of his own goal — a keeper who sprints to the halfway line because
     * a button is held is worse than no command at all.
     */
    if (world.keeperRush && p.side === world.config.humanSide) {
      const own = ownGoalCenter(world, p.side);
      const target = interceptPoint(world, 0.35);
      if (dist(target, own) < 30) {
        setIntent(p, clampToPitch(target), true);
        return;
      }
    }
    decideKeeper(world, p, profile);
    return;
  }

  const ball = ballPos2(world);
  const teamHasBall = world.possession === p.side;
  const chaser = nearestOf(world, ball, p.side);
  const secondChaser = nearestOf(world, ball, p.side, true, chaser?.id ?? -1);
  /*
   * Recovery runs. Sprinting off the ball used to be a coin flip against `sprintBias`, so a
   * midfielder caught upfield when possession turned over would amble back at a jog while the
   * break went past him. If he is the wrong side of the ball with his own goal behind him, he
   * runs — that is not a decision a footballer agonises over.
   */
  const recovering = !teamHasBall && (p.pos.x - world.ball.pos.x) * world.attackDir[p.side] > 2;
  const wantsSprint =
    (recovering && p.stamina > 0.12) || (p.stamina > 0.25 && world.rand() < profile.sprintBias);

  /*
   * Follow the shot in. Real strikers start moving the moment it is struck, gambling on the
   * rebound — nobody in this game did, which is half of why rebounds died. Applies while the
   * ball is in flight at their goal, to the two attackers best placed to profit.
   */
  if (teamHasBall && world.shotAge < 1.4 && world.controllerId === null) {
    const target = goalCenter(world, p.side);
    const struck = Math.hypot(world.ball.vel.x, world.ball.vel.z);
    const atGoal = (target.x - world.ball.pos.x) * world.ball.vel.x > 0;
    if (struck > 13 && atGoal && dist(p.pos, target) < 30 && p.role !== 'DF') {
      const gamblers = world.players
        .filter((q) => q.side === p.side && q.role !== 'GK' && q.role !== 'DF' && !q.sentOff)
        .sort((x, y) => dist(x.pos, target) - dist(y.pos, target))
        .slice(0, 2);
      if (gamblers.some((q) => q.id === p.id)) {
        // Attack the space in front of the keeper, where parries and blocks fall.
        const dir = world.attackDir[p.side];
        setIntent(p, clampToPitch({ x: target.x - dir * 7, z: clamp(p.pos.z, -8, 8) }), true);
        return;
      }
    }
  }

  /*
   * Forwards move when their team has the ball. They used to stand on their formation anchor
   * waiting to be found, which starved the carrier of options and funnelled every attack into
   * a dribble. Two behaviours, alternating on the AI's own cadence: pin the last defender's
   * shoulder holding an onside buffer, and break in behind when the carrier is set to play it.
   */
  if (
    teamHasBall &&
    p.role === 'FW' &&
    world.controllerId !== p.id &&
    world.controllerId !== null
  ) {
    const carrier = world.players.find((q) => q.id === world.controllerId);
    if (carrier && carrier.side === p.side) {
      const attack = world.attackDir[p.side];
      const line = world.players
        .filter((q) => q.side !== p.side && q.role !== 'GK' && !q.sentOff)
        .reduce(
          (deepest, q) => (q.pos.x * attack > deepest ? q.pos.x * attack : deepest),
          -HALF_LENGTH,
        );
      const carrierSet = nearestOpponentDistance(world, carrier) > 2.5;
      const inRange = dist(carrier.pos, p.pos) < 32;
      const upfield = carrier.pos.x * attack > -5;
      // Episodic, not permanent: a striker who is *always* breaking is unmarkable and the game
      // becomes a shooting gallery — measured at 7 goals and up to 63 shots a match. Roughly one
      // decision in three commits to the run; the rest of the time he pins the line.
      if (carrierSet && inRange && upfield && p.stamina > 0.2 && world.rand() < 0.32) {
        // Break: flat-out beyond the line, bending to stay a stride onside until it is played.
        const holdX = (line - 0.8) * attack;
        setIntent(p, clampToPitch({ x: holdX + attack * 6, z: clamp(p.pos.z, -18, 18) }), true);
        return;
      }
      // Pin: sit on the last defender's shoulder so the line cannot step up in comfort.
      setIntent(p, clampToPitch({ x: (line - 1.2) * attack, z: clamp(p.pos.z, -20, 20) }), false);
      return;
    }
  }

  if (!teamHasBall) {
    /*
     * Ten yards. At a free kick or a corner the defending side has to retreat 9.15m from the
     * ball, and none of that was modelled — defenders simply stood wherever they happened to be,
     * often right on top of the ball.
     */
    const set = world.restart;
    if (set && set.side !== p.side && (set.kind === 'free-kick' || set.kind === 'corner')) {
      const fromBall = dist(p.pos, ball);
      if (fromBall < TEN_YARDS) {
        const outward =
          fromBall < 0.01
            ? { x: 1, z: 0 }
            : { x: (p.pos.x - ball.x) / fromBall, z: (p.pos.z - ball.z) / fromBall };
        setIntent(
          p,
          clampToPitch({
            x: ball.x + outward.x * (TEN_YARDS + 0.5),
            z: ball.z + outward.z * (TEN_YARDS + 0.5),
          }),
          false,
          sub(ball, p.pos),
        );
        return;
      }
    }

    /*
     * Kickoff: stay out of the centre circle until they have played it. Without this the whistle
     * went and the opposition simply charged the spot and took the ball off you.
     */
    if (world.kickoffProtected) {
      const fromSpot = Math.hypot(p.pos.x, p.pos.z);
      if (fromSpot < CENTER_CIRCLE_RADIUS + 0.6) {
        const outward =
          fromSpot < 0.01 ? { x: 0, z: 1 } : { x: p.pos.x / fromSpot, z: p.pos.z / fromSpot };
        const edge = CENTER_CIRCLE_RADIUS + 1.2;
        setIntent(p, clampToPitch({ x: outward.x * edge, z: outward.z * edge }), false);
        return;
      }
      setIntent(p, clampToPitch(shapeTarget(world, p)), false);
      return;
    }

    /*
     * An attacker driving into shooting range has to be closed down, not escorted. Defenders were
     * retreating towards their own goal on the assumption that depth is safety — but inside about
     * twenty-two metres the man simply shoots, and backing off hands him the yard he needs. The
     * two nearest defenders step out and engage; the rest keep the shape behind them.
     */
    const carrierNow = world.players.find((q) => q.id === world.controllerId);
    if (carrierNow && carrierNow.side !== p.side) {
      const own = ownGoalCenter(world, p.side);
      const range = dist(carrierNow.pos, own);
      if (range < 24) {
        const closest = world.players
          .filter((q) => q.side === p.side && q.role !== 'GK' && !q.sentOff)
          .sort((x, y) => dist(x.pos, carrierNow.pos) - dist(y.pos, carrierNow.pos));
        if (closest[0]?.id === p.id || closest[1]?.id === p.id) {
          // Goal-side but tight enough to be in his face rather than shepherding him in.
          const goalSide = normalize(sub(own, carrierNow.pos));
          const stand = closest[0]?.id === p.id ? 1.1 : 2.6;
          setIntent(
            p,
            clampToPitch({
              x: carrierNow.pos.x + goalSide.x * stand,
              z: carrierNow.pos.z + goalSide.z * stand,
            }),
            true,
            sub(carrierNow.pos, p.pos),
          );
          return;
        }
      }
    }
    /*
     * A ball has been struck at our goal. Anyone close to its line throws himself in front of
     * it rather than carrying on marking a runner — previously a shot simply flew past
     * defenders who were still holding their shape, which is the thing that reads as nobody
     * caring that a shot is happening.
     */
    const struck = Math.hypot(world.ball.vel.x, world.ball.vel.z);
    /*
     * A defender does not know where a shot is going the instant it leaves the boot. Reading the
     * ball's velocity on the tick it was struck gave every defender perfect knowledge with zero
     * latency, which is what produces blocks that look impossible. He reacts only after his own
     * perception delay — quicker if he is a good defender, slower if the ball is behind him.
     */
    const facing = { x: Math.sin(p.heading), z: Math.cos(p.heading) };
    const toBall = normalize(sub(ball, p.pos));
    const seesIt = facing.x * toBall.x + facing.z * toBall.z > 0.1;
    const reaction =
      (seesIt ? 0.2 : 0.42) + (1 - profile.marking) * 0.12 + (1 - p.defending / 100) * 0.16;

    /*
     * Reading the backswing. A defender does not wait for the ball to be travelling before he
     * throws himself at the line — he reacts to the wound-up leg. Any nearby opponent deep in a
     * wind-up (a charging human or an AI's planned strike) pulls the close defender onto the
     * shooting lane *before* contact. This is also, deliberately, what the charge-feint baits:
     * winding up and cancelling drags a block out of position, exactly as it should.
     */
    if (seesIt) {
      const winder = world.players.find(
        (q) =>
          q.side !== p.side &&
          !q.sentOff &&
          q.windup > 0.55 &&
          world.controllerId === q.id &&
          dist(q.pos, p.pos) < 6 &&
          dist(q.pos, ownGoalCenter(world, p.side)) < 28,
      );
      if (winder) {
        const own = ownGoalCenter(world, p.side);
        const lane = normalize(sub(own, winder.pos));
        setIntent(
          p,
          clampToPitch({ x: winder.pos.x + lane.x * 1.6, z: winder.pos.z + lane.z * 1.6 }),
          true,
          sub(winder.pos, p.pos),
        );
        return;
      }
    }
    if (
      world.shotAge >= reaction &&
      struck > 13 &&
      world.ball.pos.y < 1.8 &&
      dist(ball, ownGoalCenter(world, p.side)) < 30
    ) {
      const own = ownGoalCenter(world, p.side);
      const goingAtGoal = (own.x - world.ball.pos.x) * world.ball.vel.x > 0;
      if (goingAtGoal) {
        // Where the ball will be in a moment, and how far he is off that line.
        const lead = 0.35;
        const ahead = {
          x: world.ball.pos.x + world.ball.vel.x * lead,
          z: world.ball.pos.z + world.ball.vel.z * lead,
        };
        const offLine = distToSegment(p.pos, ball, ahead);
        if (offLine < 2.2) {
          setIntent(p, clampToPitch(ahead), true);
          return;
        }
      }
    }
    /*
     * A ball is travelling between two opponents. Only the single nearest defender ever went for
     * it, so a pass into a lane a defender was standing in simply sailed past him. Anyone close
     * to the line attacks it — once his own perception delay has elapsed, so this reads as
     * reading the pass rather than clairvoyance.
     */
    // Passes only. A ball hammered at our goal is the shot-block branch's business above, which
    // is gated far more tightly; letting this one chase shots as well doubled the block rate.
    const isPass = struck > 5 && struck < 24;
    if (world.controllerId === null && isPass) {
      const lead = 0.5;
      const ahead = {
        x: world.ball.pos.x + world.ball.vel.x * lead,
        z: world.ball.pos.z + world.ball.vel.z * lead,
      };
      const offLine = distToSegment(p.pos, ball, ahead);
      if (world.shotAge >= reaction && offLine < 3.5 && chaser?.id !== p.id) {
        setIntent(p, clampToPitch(interceptPoint(world, 0.35)), p.stamina > 0.12);
        return;
      }
    }
    if (chaser?.id === p.id) {
      /*
       * Contain, do not charge. When the opponent has the ball under control, running straight
       * at it takes the defender *through* the carrier and out of the game the instant he cuts.
       * The nearest man instead holds a point on the carrier-goal line just off him, matching
       * his pace — the existing challenge logic wins the ball when it is actually loose or the
       * carrier's touch strays. A genuinely loose ball is still chased flat out.
       */
      const carrier = world.players.find((q) => q.id === world.controllerId);
      if (carrier && carrier.side !== p.side) {
        const own = ownGoalCenter(world, p.side);
        // Anchor on the ball, not the man: the ball is what he actually pokes, and the touch
        // scheduler leaves it rolling in front of the carrier where it can genuinely be won.
        const goalSide = normalize(sub(own, ball));
        setIntent(
          p,
          clampToPitch({
            // Inside challenge range: containing from beyond it produced a stand-off where
            // neither man could ever win the ball. He shows the carrier one way and still bites.
            x: ball.x + world.ball.vel.x * 0.25 + goalSide.x * 0.8,
            z: ball.z + world.ball.vel.z * 0.25 + goalSide.z * 0.8,
          }),
          p.stamina > 0.15,
          sub(ball, p.pos),
        );
        return;
      }
      setIntent(p, clampToPitch(interceptPoint(world)), p.stamina > 0.15);
      return;
    }
    if (secondChaser?.id === p.id) {
      const own = ownGoalCenter(world, p.side);
      const toGoal = normalize(sub(own, ball));
      setIntent(
        p,
        clampToPitch({ x: ball.x + toGoal.x * 6, z: ball.z + toGoal.z * 6 }),
        wantsSprint,
      );
      return;
    }
    const mark = markTarget(world, p, profile);
    const shape = shapeTarget(world, p);
    const w = profile.marking * 0.75;
    const target = mark
      ? { x: shape.x * (1 - w) + mark.x * w, z: shape.z * (1 - w) + mark.z * w }
      : shape;
    // A marker holds his position bladed to the ball; he does not turn his back on it to jog to
    // a spot. Only when the move is a genuine recovery sprint does he turn and run.
    const blade = wantsSprint && dist(p.pos, target) > 9 ? null : sub(ball, p.pos);
    setIntent(p, target, wantsSprint && dist(p.pos, target) > 9, blade);
    return;
  }

  // In possession without the ball: support the carrier and stretch the defence.
  const carrier = world.players.find((c) => c.id === world.controllerId);
  // The ball has been played to this man: go and get it, do not stand in your shape and watch
  // the defender run onto it.
  if (!carrier && world.passTarget?.playerId === p.id) {
    setIntent(
      p,
      clampToPitch(interceptPoint(world, 0.4)),
      p.stamina > 0.12,
      sub(ballPos2(world), p.pos),
    );
    return;
  }
  // A pass is in flight: the closest man goes and meets it instead of holding his shape.
  if (!carrier && chaser?.id === p.id) {
    setIntent(p, clampToPitch(interceptPoint(world, 0.5)), p.stamina > 0.15);
    return;
  }
  const shape = shapeTarget(world, p);
  if (carrier && carrier.id !== p.id && dist(carrier.pos, p.pos) < 14) {
    const away = normalize(sub(p.pos, carrier.pos));
    const support = clampToPitch({
      x: p.pos.x + away.x * 5 + world.attackDir[p.side] * 3,
      z: p.pos.z + away.z * 5,
    });
    setIntent(p, { x: (shape.x + support.x) / 2, z: (shape.z + support.z) / 2 }, wantsSprint);
    return;
  }
  setIntent(p, shape, wantsSprint && dist(p.pos, shape) > 9);
}

function decideKeeper(world: SimWorld, p: SimPlayer, profile: DifficultyProfile): void {
  const own = ownGoalCenter(world, p.side);
  const ball = ballPos2(world);
  const toBall = normalize(sub(ball, own));
  const ballDist = dist(ball, own);

  /*
   * One against one, the keeper does not stand on his line waiting to be picked off — he comes
   * to meet the carrier and closes the angle, which is the entire craft of the position in that
   * moment. Triggered when an opponent has the ball inside ~20m with no team-mate goal-side.
   */
  const carrier = world.players.find((q) => q.id === world.controllerId);
  /*
   * 14m and 5m out, not 20m and 8m: the deeper rush left an empty net behind him for the whole
   * of an attacker's wind-up, and the AI learned to simply square the ball past him — ten goals
   * a match, a third of them passes rolling in untouched.
   */
  if (carrier && carrier.side !== p.side && dist(carrier.pos, own) < 14) {
    const cover = world.players.some(
      (q) =>
        q.side === p.side &&
        q.role !== 'GK' &&
        !q.sentOff &&
        dist(q.pos, own) < dist(carrier.pos, own) &&
        Math.abs(q.pos.z - carrier.pos.z) < 4,
    );
    if (!cover) {
      const line = normalize(sub(carrier.pos, own));
      const out = clamp(dist(carrier.pos, own) * 0.4, 1.5, 5);
      setIntent(p, { x: own.x + line.x * out, z: own.z + line.z * out }, true);
      return;
    }
  }
  /*
   * Sweeper-keeper. A through ball rolling into the space behind the back line is his, not the
   * striker's — provided he genuinely gets there first. He races the nearest opponent to the
   * intercept point and only commits when he wins that race with a stride to spare; a keeper
   * who loses it has left an empty net.
   */
  if (world.controllerId === null && world.ball.pos.y < 1.2) {
    const target = interceptPoint(world, 0.5);
    const range = dist(target, own);
    if (range < 24 && (target.x - own.x) * world.attackDir[p.side] > 0) {
      const mine = dist(p.pos, target);
      const opp = nearestOf(world, target, p.side === 'home' ? 'away' : 'home');
      const mate = nearestOf(world, target, p.side);
      const oppD = opp ? dist(opp.pos, target) : Infinity;
      const mateD = mate ? dist(mate.pos, target) : Infinity;
      // Sharper difficulties read the race earlier and gamble on tighter margins.
      const margin = 3.2 - profile.marking * 1.6;
      if (mine + margin < oppD && mine < mateD && oppD < 18) {
        setIntent(p, clampToPitch(target), true);
        return;
      }
    }
  }
  /*
   * Balls rolling *across* the goalmouth. The dive logic keys on velocity towards the goal, so a
   * square ball or cutback — vel.x near zero — was literally invisible to him and rolled through
   * the six-yard box untouched; a third of all goals had become passes into an empty corner.
   * The trajectory cache sees it: if the flight passes through the strip in front of goal, he
   * attacks the crossing point.
   */
  if (world.flight && world.controllerId === null) {
    for (const f of world.flight) {
      if (Math.abs(f.x - own.x) < 4.5 && Math.abs(f.z - own.z) < 7 && f.y < 1.7) {
        const reach = dist(p.pos, { x: f.x, z: f.z }) / Math.max(4.5, f.t + 0.01);
        if (reach < 9 || f.t > 0.35) {
          setIntent(p, { x: f.x, z: f.z }, true, sub(ballPos2(world), p.pos));
          return;
        }
      }
    }
  }

  const advance = clamp(ballDist * 0.14, 0.5, 3.5) * (0.7 + profile.marking * 0.4);
  const target = {
    x: own.x + toBall.x * advance,
    z: clamp(own.z + toBall.z * advance * 1.6, -HALF_GOAL_WIDTH - 2.2, HALF_GOAL_WIDTH + 2.2),
  };

  // Ball travelling at goal: cover where it will cross the line rather than chasing it.
  const closing = Math.abs(world.ball.vel.x);
  const towardsGoal = (own.x - world.ball.pos.x) * world.ball.vel.x > 0;
  if (towardsGoal && closing > 5) {
    const eta = Math.abs(own.x - world.ball.pos.x) / closing;
    if (eta < 2.5) {
      // Keepers read the shot imperfectly; sharper difficulties guess closer to the truth.
      const misread = (1.1 + closing * 0.09) * (1.35 - profile.marking);
      // Derived from the shot's own velocity so the error stays stable during its flight.
      const guess = Math.sin(world.ball.vel.x * 3.1 + world.ball.vel.z * 7.7);
      const crossZ = world.ball.pos.z + world.ball.vel.z * eta + guess * misread;
      setIntent(
        p,
        {
          x: own.x + toBall.x * Math.min(advance, 1.2),
          z: clamp(crossZ, -HALF_GOAL_WIDTH - 0.5, HALF_GOAL_WIDTH + 0.5),
        },
        true,
      );
      return;
    }
  }
  // Rush out to smother a loose ball inside the box.
  const rush = ballDist < 14 && world.possession !== p.side && world.ball.pos.y < 1.6;
  setIntent(p, rush && ballDist < 9 ? ball : target, rush);
}

/** Decision for the AI player currently in control of the ball. Returns true if it kicked. */
export function decideOnBall(world: SimWorld, p: SimPlayer, profile: DifficultyProfile): boolean {
  const goal = goalCenter(world, p.side);
  const pressure = nearestOpponentDistance(world, p);

  if (p.role === 'GK') {
    /*
     * Distribution is a decision, not a clearance. A short option under no pressure gets the
     * ball rolled to his feet; a man further out gets it clipped to him; and only when nothing
     * is on does the keeper put his laces through it. He never rolls it to a marked defender —
     * that is how keepers concede to the press.
     */
    const pass = bestPass(world, p, sub(goal, p.pos));
    const upfield = normalize(sub(goal, p.pos));
    if (pass && pass.score > 0.7) {
      const d = dist(p.pos, pass.spot);
      const targetPressure = nearestOpponentDistance(world, pass.target);
      if (d < 18 && targetPressure > 6) {
        // Rolled out along the ground, weighted to be taken in stride.
        kickPass(world, p, pass.spot, profile, 0.8, { receiverId: pass.target.id, lift: 0 });
      } else if (targetPressure > 3.5) {
        kickPass(world, p, pass.spot, profile, 1, {
          receiverId: pass.target.id,
          lift: d > 26 ? 3.5 : 0,
        });
      } else {
        applyKick(world, p, upfield, 24, 5.5);
        world.events.push({ type: 'kick', side: p.side, intensity: 0.9 });
      }
    } else {
      applyKick(world, p, upfield, 22, 5);
      world.events.push({ type: 'kick', side: p.side, intensity: 0.9 });
    }
    return true;
  }

  // Mid-backswing: the decision is made, let the swing finish.
  if (p.plannedShot) return true;
  const quality = shotQuality(world, p.pos, p.side);
  // High enough that half-chances get worked rather than leathered from anywhere.
  const shootBar = 0.45 + (1 - profile.shotAccuracy) * 0.2;
  // Inside the box with any sort of angle, take the shot rather than walking it in.
  const goalDist = dist(p.pos, goal);
  // Nobody dribbles it over the line: from the six-yard box he simply hits it.
  const pointBlank = goalDist < 16 && Math.abs(p.pos.z) < 14 && (pressure > 1.6 || goalDist < 7);
  if (pointBlank || quality > shootBar) {
    /*
     * Not yet — wind up first. The AI used to strike instantly off an unwound leg, which both
     * looked wrong and gave defenders nothing to read: a shot existed only after the ball was
     * already travelling. The backswing is ~a third of a second, snap finishes shorter.
     */
    p.plannedShot = { at: pointBlank ? 0.22 : 0.34, quality };
    return true;
  }

  // Look for the pass that breaks the line first, then the safe one.
  const through = bestThroughBall(world, p);
  if (through && through.score > 1.9 && p.passing > 62) {
    kickPass(world, p, through.spot, profile, 0.95, { receiverId: through.target.id });
    return true;
  }

  const pass = bestPass(world, p);
  if (pass && (pressure < 3.4 || pass.score > 1.5) && pass.score > 0.55) {
    kickPass(world, p, pass.spot, profile, 1, { receiverId: pass.target.id });
    return true;
  }

  // Carry the ball at goal, steering around the nearest defender.
  const toGoal = normalize(sub(goal, p.pos));
  let steer = toGoal;
  const defender = nearestOf(world, p.pos, p.side === 'home' ? 'away' : 'home');
  if (defender && dist(defender.pos, p.pos) < 6) {
    const away = normalize(sub(p.pos, defender.pos));
    steer = normalize({ x: toGoal.x + away.x * 1.3, z: toGoal.z + away.z * 1.3 });
  }
  p.intent = steer;
  // Under real pressure a strong carrier shields the ball instead of running into the tackle.
  p.shielding = pressure < 1.8 && p.physical > 68;
  p.intentSprint = !p.shielding && p.stamina > 0.2 && world.rand() < profile.sprintBias;
  return false;
}

/**
 * `speed` overrides the strike entirely: the human's hold-to-power model decides the pace, and
 * this function only does the aiming. Without it the shot speed came out of the distance to
 * goal and the charge merely scaled it, so hold time barely related to how hard the ball was
 * hit and a full charge never got near the configured maximum.
 */
export function shoot(
  world: SimWorld,
  p: SimPlayer,
  profile: DifficultyProfile,
  quality: number,
  powerScale = 1,
  speed?: number,
): void {
  const goal = goalCenter(world, p.side);
  const d = dist(p.pos, goal);
  // The CPU finishes through the same solver as the player: pick a target, then solve the
  // launch that reaches it. Difficulty rides on the spread, not on a different mechanism.
  const charge = clamp(
    (speed ?? clamp(MIN_SHOT_POWER + d * 0.62, MIN_SHOT_POWER, MAX_SHOT_POWER) * powerScale) /
      world.tuning.shot.maxSpeed,
    0.35,
    1,
  );
  const tuning = {
    ...world.tuning.shot,
    // A weaker profile, or a snatched chance, simply misses by more.
    baseSpread:
      world.tuning.shot.baseSpread * (2.1 - profile.shotAccuracy * 1.6) * (1.3 - quality * 0.3),
  };
  const style: ShotStyle = d > 24 && world.rand() < 0.5 ? 'driven' : 'finesse';
  const result = strike(
    world,
    p,
    { style, charge, aim: null, pressure: nearestOpponentDistance(world, p) },
    tuning,
  );
  registerShot(world, p, { x: goal.x, z: result.targetZ });
  world.events.push({
    type: 'shot',
    side: p.side,
    intensity: clamp(result.speed / world.tuning.shot.maxSpeed, 0, 1),
  });
}

export interface PassOptions {
  /** Vertical impulse. 0 keeps it on the deck; a lofted pass or cross needs 3+. */
  lift?: number;
  /** Side spin in rad/s. Defaults to a little natural whip on anything lofted. */
  curl?: number;
  /**
   * Explicit horizontal ball speed in m/s. The human's hold-to-power model sets this so the
   * charge decides the pace; leave it unset and the AI's distance-based strength is used.
   */
  speed?: number;
  /** The team-mate the pass is meant for, so he goes and meets it. */
  receiverId?: number;
}

export function kickPass(
  world: SimWorld,
  p: SimPlayer,
  spot: Vec2,
  profile: DifficultyProfile,
  powerScale = 1,
  options: PassOptions = {},
): void {
  const d = dist(p.pos, spot);
  const skill = profile.passAccuracy * (0.6 + p.passing / 250);
  const spread = (1 - clamp(skill, 0, 1)) * (1.2 + d * 0.09);
  const aim = {
    x: spot.x + (world.rand() * 2 - 1) * spread,
    z: spot.z + (world.rand() * 2 - 1) * spread,
  };
  const dir = normalize(sub(aim, p.pos));
  let power = options.speed ?? clamp(5 + d * 0.82, MIN_PASS_POWER, MAX_PASS_POWER) * powerScale;
  /*
   * A pass whose lane crosses the goal mouth is one missed touch from being a shot, and the AI
   * was scoring four or five a match this way — ordinary thirteen-metre balls at 15 m/s squared
   * across the box, missing their man and rolling in. Nobody deliberately blasts a ball through
   * the frame at a teammate: take the pace off so a miss dies at the line, gatherable.
   */
  const gx = dir.x > 0 ? HALF_LENGTH : -HALF_LENGTH;
  const tLine = (gx - p.pos.x) / (dir.x || 1e-9);
  if (tLine > 0 && tLine < d + 8) {
    const zAt = p.pos.z + dir.z * tLine;
    if (Math.abs(zAt) < HALF_GOAL_WIDTH + 0.8) power = Math.min(power, Math.max(7, tLine * 0.7));
  }
  const lift = options.lift ?? (d > 24 ? 2.4 : 0);
  // A whipped cross bends away from the keeper; a ground pass is struck flat.
  const curl = options.curl ?? (lift > 2.5 ? curlToward(p.pos, dir, aim, 0.35) : 0);
  applyKick(world, p, dir, power, lift, curl, 'pass');
  // Tell the intended receiver the ball is for him; cleared as soon as anyone controls it.
  if (options.receiverId !== undefined) {
    world.passTarget = { playerId: options.receiverId, spot };
    // He reacts to the pass now rather than on his next scheduled think, which can be most of
    // a second away — long enough for a defender to get there first.
    const receiver = world.players.find((r) => r.id === options.receiverId);
    if (receiver) receiver.thinkTimer = 0;
  }
  world.stats[p.side].passes += 1;
  p.tally.passes += 1;
  world.events.push({ type: 'pass', side: p.side, intensity: clamp(power / MAX_PASS_POWER, 0, 1) });
}

/** Records a shot and whether it was heading between the posts. */
export function registerShot(world: SimWorld, p: SimPlayer, aim: Vec2): void {
  world.shots[p.side] += 1;
  world.stats[p.side].shots += 1;
  p.tally.shots += 1;
  if (Math.abs(aim.z) < HALF_GOAL_WIDTH) world.stats[p.side].onTarget += 1;
}
