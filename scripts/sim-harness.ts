/**
 * Headless match harness: runs the simulation with a lightweight ball integrator instead of
 * Rapier so AI, rules and kick/reset logic can be validated in CI without a browser.
 *
 *   npx tsx scripts/sim-harness.ts [matches]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BALL_MASS,
  BALL_RADIUS,
  HALF_LENGTH,
  HALF_WIDTH,
  PENALTY_BOX_DEPTH,
  TICK_DT,
} from '../src/game/constants';
import type { ActionName, InputFrame } from '../src/game/input/input';
import { ACTIONS, InputManager } from '../src/game/input/input';
import { applyKick } from '../src/game/sim/kick';
import { awardFoul, book, flagOffsides, whistleOffside } from '../src/game/sim/rules';
import { performSkill } from '../src/game/sim/skills';
import {
  createWorld,
  matchRating,
  snapshot,
  type MatchConfig,
  type SimPlayer,
  type SimWorld,
} from '../src/game/sim/state';
import { tick } from '../src/game/sim/step';
import { predictedBall, rankSwitchCandidates, requestSwitch } from '../src/game/sim/switching';
import type { Vec3 } from '../src/game/sim/math';
import type { Difficulty, TeamsFile } from '../src/game/types';

const here = dirname(fileURLToPath(import.meta.url));
const teams = (
  JSON.parse(readFileSync(resolve(here, '../public/data/teams.json'), 'utf8')) as TeamsFile
).teams;

const idleActions = (): InputFrame['actions'] =>
  Object.fromEntries(
    ACTIONS.map((a) => [
      a,
      {
        down: false,
        pressed: false,
        released: false,
        heldTime: 0,
        doubleTap: false,
        fired: false,
        charge: 0,
        autoFired: false,
      },
    ]),
  ) as InputFrame['actions'];

const idleInput: InputFrame = {
  move: { x: 0, z: 0 },
  flick: { x: 0, z: 0 },
  actions: idleActions(),
};

/**
 * A bare input manager for the sim: the harness drives `InputFrame`s directly, so the manager is
 * only here to carry the attack/defence context and the action buffer.
 */
const manager = (): InputManager => new InputManager();

/** A fresh world with the kickoff teleport already consumed, ready to be posed by a check. */
function newWorld(seed: number): SimWorld {
  const world = createWorld(baseConfig(seed));
  world.commands.length = 0;
  return world;
}

const baseConfig = (seed: number): MatchConfig => ({
  homeTeam: teams[0],
  awayTeam: teams[1],
  homeFormation: teams[0].formation,
  awayFormation: teams[1].formation,
  humanSide: 'home',
  difficulty: 'normal',
  halfLength: 60,
  seed,
});

/** Runs the world (and the stand-in ball integrator) for `seconds`, collecting the events. */
function run(world: SimWorld, seconds: number): string[] {
  const seen: string[] = [];
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    world.activeId = -1;
    const before = { ...world.ball.vel };
    tick(world, idleInput, 0, TICK_DT, manager());
    for (const event of world.events) seen.push(event.type);
    stepBall(world, TICK_DT, before);
    world.events.length = 0;
  }
  return seen;
}

const outfield = (world: SimWorld, side: 'home' | 'away'): SimPlayer => {
  const p = world.players.find((q) => q.side === side && q.role !== 'GK');
  if (!p) throw new Error('no outfield player');
  return p;
};

const GRAVITY = -9.81;
const RESTITUTION = 0.62;
const ROLL_DAMPING = 0.65;
const AIR_DAMPING = 0.32;

/**
 * Minimal stand-in for the Rapier ball body: gravity, bounce, rolling friction.
 * `before` is the ball velocity as the tick started, standing in for the physics body's own
 * velocity — impulses are applied to that, exactly as Rapier would, rather than to the
 * predicted velocity the simulation writes into `world.ball` when it plays a kick.
 */
function stepBall(world: SimWorld, dt: number, before: Vec3): void {
  const ball = world.ball;
  ball.vel = { ...before };
  for (const command of world.commands) {
    if (command.type === 'impulse') {
      ball.vel.x += command.impulse.x / BALL_MASS;
      ball.vel.y += command.impulse.y / BALL_MASS;
      ball.vel.z += command.impulse.z / BALL_MASS;
    } else if (command.type === 'velocity') {
      ball.vel = { ...command.vel };
    } else {
      ball.pos = { ...command.pos };
      ball.vel = { x: 0, y: 0, z: 0 };
    }
  }
  world.commands.length = 0;

  ball.vel.y += GRAVITY * dt;
  ball.pos.x += ball.vel.x * dt;
  ball.pos.y += ball.vel.y * dt;
  ball.pos.z += ball.vel.z * dt;

  const grounded = ball.pos.y <= BALL_RADIUS + 1e-4;
  if (ball.pos.y < BALL_RADIUS) {
    ball.pos.y = BALL_RADIUS;
    ball.vel.y = Math.abs(ball.vel.y) < 0.6 ? 0 : -ball.vel.y * RESTITUTION;
  }
  const damping = grounded ? ROLL_DAMPING : AIR_DAMPING;
  const decay = Math.exp(-damping * dt);
  ball.vel.x *= decay;
  ball.vel.z *= decay;
}

interface Result {
  score: { home: number; away: number };
  shots: { home: number; away: number };
  possession: { home: number; away: number };
  goalKinds: Record<string, number>;
  ticks: number;
  seconds: number;
}

function playMatch(seed: number, difficulty: Difficulty, halfLength: number): Result {
  const world = createWorld({
    homeTeam: teams[seed % teams.length],
    awayTeam: teams[(seed + 1) % teams.length],
    homeFormation: teams[seed % teams.length].formation,
    awayFormation: teams[(seed + 1) % teams.length].formation,
    humanSide: 'home',
    difficulty,
    halfLength,
    seed,
  });

  const started = Date.now();
  let ticks = 0;
  let lastKick = { tick: -999, type: 'none' };
  const goalKinds: Record<string, number> = {};
  while (world.phase !== 'end' && ticks < 60 * 60 * 40) {
    // No player id is -1, so every player (both teams) is driven by the AI.
    world.activeId = -1;
    const before = { ...world.ball.vel };
    tick(world, idleInput, 0, TICK_DT, manager());
    for (const event of world.events) {
      if (event.type === 'shot' || event.type === 'pass' || event.type === 'kick') {
        lastKick = { tick: ticks, type: event.type };
      } else if (event.type === 'goal') {
        const kind = ticks - lastKick.tick > 40 ? 'walked-in' : lastKick.type;
        goalKinds[kind] = (goalKinds[kind] ?? 0) + 1;
      }
    }
    stepBall(world, TICK_DT, before);
    world.events.length = 0;
    ticks += 1;
    const ball = world.ball.pos;
    if (!Number.isFinite(ball.x) || !Number.isFinite(ball.y) || !Number.isFinite(ball.z)) {
      throw new Error(`ball position diverged at tick ${ticks}`);
    }
  }
  if (world.phase !== 'end') throw new Error('match never reached full time');

  const total = world.possessionTicks.home + world.possessionTicks.away || 1;
  return {
    score: { ...world.score },
    shots: { ...world.shots },
    possession: {
      home: Math.round((world.possessionTicks.home / total) * 100),
      away: Math.round((world.possessionTicks.away / total) * 100),
    },
    goalKinds,
    ticks,
    seconds: (Date.now() - started) / 1000,
  };
}

function checkKickAndReset(): void {
  const world = createWorld({
    homeTeam: teams[0],
    awayTeam: teams[1],
    homeFormation: teams[0].formation,
    awayFormation: teams[1].formation,
    humanSide: 'home',
    difficulty: 'normal',
    halfLength: 60,
    seed: 7,
  });
  const before = snapshot(world, 0);
  if (before.ball.pos.x !== 0 || before.ball.pos.z !== 0) {
    throw new Error('kickoff did not centre the ball');
  }
  if (JSON.parse(JSON.stringify(before)).players.length !== 22) {
    throw new Error('snapshot is not serialisable to 22 players');
  }

  // Kickoff countdown, then let play run until someone strikes the ball.
  let kicked = false;
  for (let i = 0; i < 60 * 30 && !kicked; i++) {
    const before = { ...world.ball.vel };
    tick(world, idleInput, 0, TICK_DT, manager());
    kicked = world.commands.some((c) => c.type === 'impulse');
    stepBall(world, TICK_DT, before);
    world.events.length = 0;
  }
  if (!kicked) throw new Error('no kick was applied in the first 30 seconds');
  if (Math.hypot(world.ball.vel.x, world.ball.vel.z) < 0.5) {
    throw new Error('kick did not move the ball');
  }
}

interface ControlCase {
  name: string;
  action: ActionName;
  /** Buttons held while the kick button is released, as on the pad's shoulders. */
  mods?: ActionName[];
  doubleTap?: boolean;
  minSpeed: number;
  /** Whether the kick is expected to leave the ground. */
  lofted?: boolean;
  /** Normalised 0..1 hold. Defaults to a half charge. */
  charge?: number;
}

const CONTROL_CASES: ControlCase[] = [
  { name: 'ground pass', action: 'pass', minSpeed: 6 },
  { name: 'lofted pass', action: 'pass', doubleTap: true, minSpeed: 6, lofted: true },
  { name: 'driven pass', action: 'pass', mods: ['modR1'], minSpeed: 10 },
  { name: 'through ball', action: 'through', minSpeed: 8 },
  { name: 'lobbed through ball', action: 'through', mods: ['modL1'], minSpeed: 8, lofted: true },
  { name: 'cross', action: 'cross', minSpeed: 10, lofted: true },
  { name: 'driven cross', action: 'cross', mods: ['modR1'], minSpeed: 12, lofted: true },
  { name: 'shot', action: 'shoot', minSpeed: 14 },
  { name: 'chip shot', action: 'shoot', mods: ['modL1'], minSpeed: 8, lofted: true },
];

/**
 * Every human kick must actually strike the ball, and the lofted variants must get it airborne.
 * This is the only coverage the input -> `handleHumanActions` path gets outside a browser.
 */
function checkHumanControls(): void {
  for (const test of CONTROL_CASES) {
    const world = createWorld({
      homeTeam: teams[0],
      awayTeam: teams[1],
      homeFormation: teams[0].formation,
      awayFormation: teams[1].formation,
      humanSide: 'home',
      difficulty: 'normal',
      halfLength: 60,
      seed: 11,
    });
    // Skip the kickoff countdown and hand the human the ball at the halfway line.
    world.phase = 'in-play';
    const active = world.players.find((p) => p.id === world.activeId);
    if (!active) throw new Error('no active player');
    active.pos = { x: -6, z: 0 };
    active.heading = Math.PI / 2;
    world.ball.pos = { x: active.pos.x + 0.4, y: BALL_RADIUS, z: active.pos.z };
    world.ball.vel = { x: 0, y: 0, z: 0 };
    world.controllerId = active.id;
    world.possession = 'home';

    const actions = idleActions();
    actions[test.action] = {
      ...actions[test.action],
      released: true,
      heldTime: 0.35,
      doubleTap: test.doubleTap ?? false,
      fired: true,
      charge: test.charge ?? 0.5,
    };
    for (const mod of test.mods ?? []) {
      actions[mod] = { ...actions[mod], down: true };
    }
    tick(world, { move: { x: 1, z: 0 }, flick: { x: 0, z: 0 }, actions }, 0, TICK_DT, manager());

    const impulse = world.commands.find((c) => c.type === 'impulse');
    if (!impulse || impulse.type !== 'impulse') {
      throw new Error(`${test.name}: no impulse was applied to the ball`);
    }
    const vx = impulse.impulse.x / BALL_MASS;
    const vy = impulse.impulse.y / BALL_MASS;
    const vz = impulse.impulse.z / BALL_MASS;
    const speed = Math.hypot(vx, vy, vz);
    if (speed < test.minSpeed) {
      throw new Error(`${test.name}: only ${speed.toFixed(1)} m/s, expected >= ${test.minSpeed}`);
    }
    if (test.lofted && vy < 2) {
      throw new Error(`${test.name}: expected loft, got vy ${vy.toFixed(1)}`);
    }
    if (!test.lofted && vy > 2.5) {
      throw new Error(`${test.name}: expected a low ball, got vy ${vy.toFixed(1)}`);
    }
  }
  console.log(`human control checks passed (${CONTROL_CASES.length} kicks)`);
}

/** Poses a world with the human on the ball at the halfway line, ready to strike it. */
function worldOnTheBall(seed = 11): { world: SimWorld; active: SimPlayer } {
  const world = createWorld({
    homeTeam: teams[0],
    awayTeam: teams[1],
    homeFormation: teams[0].formation,
    awayFormation: teams[1].formation,
    humanSide: 'home',
    difficulty: 'normal',
    halfLength: 60,
    seed,
  });
  world.phase = 'in-play';
  const active = world.players.find((p) => p.id === world.activeId);
  if (!active) throw new Error('no active player');
  active.pos = { x: -6, z: 0 };
  active.vel = { x: 0, z: 0 };
  active.heading = Math.PI / 2;
  world.ball.pos = { x: active.pos.x + 0.4, y: BALL_RADIUS, z: active.pos.z };
  world.ball.vel = { x: 0, y: 0, z: 0 };
  world.controllerId = active.id;
  world.possession = 'home';
  world.commands.length = 0;
  return { world, active };
}

/** Launch speed of the single impulse a kick produces. */
function struckSpeed(world: SimWorld): number {
  const impulse = world.commands.find((c) => c.type === 'impulse');
  if (!impulse || impulse.type !== 'impulse') throw new Error('no impulse was applied');
  return Math.hypot(
    impulse.impulse.x / BALL_MASS,
    impulse.impulse.y / BALL_MASS,
    impulse.impulse.z / BALL_MASS,
  );
}

/**
 * Bug #3: hold duration has to change the pace of the ball. Three holds must produce three
 * clearly distinct, increasing launch speeds for every charged action.
 */
function checkPassPower(): void {
  const charges = [0.1, 0.5, 1];
  for (const action of ['pass', 'cross', 'through', 'shoot'] as ActionName[]) {
    const speeds = charges.map((charge) => {
      const { world } = worldOnTheBall();
      const actions = idleActions();
      actions[action] = {
        ...actions[action],
        released: true,
        fired: true,
        charge,
        heldTime: charge,
      };
      tick(world, { move: { x: 1, z: 0 }, flick: { x: 0, z: 0 }, actions }, 0, TICK_DT, manager());
      return struckSpeed(world);
    });
    for (let i = 1; i < speeds.length; i++) {
      if (speeds[i] <= speeds[i - 1]) {
        throw new Error(
          `${action}: power is not monotonic in hold time — ${speeds.map((s) => s.toFixed(1)).join(' / ')} m/s`,
        );
      }
    }
    // "Clearly distinct" — a tap and a full charge must not be within noise of each other.
    if (speeds[2] - speeds[0] < 4) {
      throw new Error(
        `${action}: tap and full charge differ by only ${(speeds[2] - speeds[0]).toFixed(1)} m/s`,
      );
    }
    console.log(
      `  ${action}: ${speeds.map((s, i) => `${charges[i]}=${s.toFixed(1)}`).join('  ')} m/s`,
    );
  }
  console.log('pass/shot power checks passed');
}

/**
 * A pass has to find its man. This is the check that would have caught passes being aimed at
 * where the receiver was standing and then left for a defender to run onto: completion sat at
 * 53% across this grid, and a 22 m ball reached a team-mate 37% of the time.
 *
 * `scripts/passlab.ts` prints the full breakdown; this asserts the floor.
 */
function checkPassCompletion(): void {
  let completed = 0;
  let total = 0;
  for (const gap of [8, 15, 22, 30]) {
    for (const charge of [0.4, 0.7, 1]) {
      for (let s = 0; s < 8; s++) {
        total++;
        const world = newWorld(s * 13 + 7);
        world.phase = 'in-play';
        const dir = world.attackDir.home;
        const me = world.players.find((p) => p.id === world.activeId);
        if (!me) throw new Error('no active player');
        const mate = world.players.find(
          (p) => p.side === 'home' && p.id !== me.id && p.role !== 'GK',
        );
        const marker = world.players.find((p) => p.side === 'away' && p.role !== 'GK');
        if (!mate || !marker) throw new Error('missing players');
        for (const p of world.players) {
          if (p === me || p === mate || p === marker) continue;
          p.pos = { x: -50 * dir, z: p.pos.z };
          p.vel = { x: 0, z: 0 };
        }
        me.pos = { x: 0, z: 0 };
        me.vel = { x: 0, z: 0 };
        me.kickCooldown = 0;
        mate.pos = { x: gap * dir, z: 0 };
        mate.vel = { x: 0, z: 0 };
        marker.pos = { x: gap * dir, z: 4 };
        marker.vel = { x: 0, z: 0 };
        world.ball.pos = { x: 0.4 * dir, y: BALL_RADIUS, z: 0 };
        world.ball.vel = { x: 0, y: 0, z: 0 };
        world.controllerId = me.id;
        world.possession = 'home';
        world.commands.length = 0;

        const mgr = manager();
        const actions = idleActions();
        actions.pass = { ...actions.pass, released: true, fired: true, charge, heldTime: charge };
        let before = { ...world.ball.vel };
        tick(world, { move: { x: -dir, z: 0 }, flick: { x: 0, z: 0 }, actions }, 0, TICK_DT, mgr);
        stepBall(world, TICK_DT, before);
        world.events.length = 0;

        for (let i = 0; i < 60 * 5; i++) {
          before = { ...world.ball.vel };
          tick(world, idleInput, 0, TICK_DT, mgr);
          stepBall(world, TICK_DT, before);
          world.events.length = 0;
          const holder = world.players.find((p) => p.id === world.controllerId);
          if (holder && holder.id !== me.id) {
            if (holder.side === 'home') completed++;
            break;
          }
          if (world.phase !== 'in-play') break;
        }
      }
    }
  }
  const pct = Math.round((completed / total) * 100);
  if (pct < 80) {
    throw new Error(`pass completion is only ${pct}% across ${total} passes, expected >= 80%`);
  }
  console.log(`pass completion check passed (${pct}% of ${total} passes found a team-mate)`);
}

/**
 * Control has to follow the ball. Auto-switching used to fire only when possession changed
 * *teams*, so playing the ball to your own team-mate left you steering the man who had just
 * passed it while somebody else ran off with it.
 */
function checkSwitchOnPass(): void {
  let followed = 0;
  let received = 0;
  for (let s = 0; s < 12; s++) {
    const world = newWorld(s * 17 + 3);
    world.phase = 'in-play';
    const dir = world.attackDir.home;
    const me = world.players.find((p) => p.id === world.activeId);
    if (!me) throw new Error('no active player');
    const mate = world.players.find((p) => p.side === 'home' && p.id !== me.id && p.role !== 'GK');
    if (!mate) throw new Error('no team-mate');
    for (const p of world.players) {
      if (p === me || p === mate) continue;
      p.pos = { x: -50 * dir, z: p.pos.z };
      p.vel = { x: 0, z: 0 };
    }
    me.pos = { x: 0, z: 0 };
    me.vel = { x: 0, z: 0 };
    me.kickCooldown = 0;
    mate.pos = { x: 15 * dir, z: 2 };
    mate.vel = { x: 0, z: 0 };
    world.ball.pos = { x: 0.4 * dir, y: BALL_RADIUS, z: 0 };
    world.ball.vel = { x: 0, y: 0, z: 0 };
    world.controllerId = me.id;
    world.possession = 'home';
    world.switching.sinceManual = 99;
    world.commands.length = 0;

    const mgr = manager();
    const actions = idleActions();
    actions.pass = { ...actions.pass, released: true, fired: true, charge: 0.6, heldTime: 0.6 };
    let before = { ...world.ball.vel };
    tick(world, { move: { x: -dir, z: 0 }, flick: { x: 0, z: 0 }, actions }, 0, TICK_DT, mgr);
    stepBall(world, TICK_DT, before);
    world.events.length = 0;

    for (let i = 0; i < 60 * 5; i++) {
      before = { ...world.ball.vel };
      tick(world, idleInput, 0, TICK_DT, mgr);
      stepBall(world, TICK_DT, before);
      world.events.length = 0;
      const holder = world.players.find((p) => p.id === world.controllerId);
      if (holder && holder.id !== me.id && holder.side === 'home') {
        received++;
        if (world.activeId === holder.id) followed++;
        break;
      }
      if (world.phase !== 'in-play') break;
    }
  }
  if (received === 0) throw new Error('no pass was ever received, cannot judge switching');
  if (followed < received) {
    throw new Error(`control followed the ball on only ${followed}/${received} completed passes`);
  }
  console.log(
    `switch-on-pass check passed (${followed}/${received} passes handed you the receiver)`,
  );
}

/**
 * Bug #2: switching must pick a defender near where the ball is *going*, must never hand over
 * the keeper in open play, and repeated presses must cycle rather than stick.
 */
function checkSwitching(): void {
  const { world } = worldOnTheBall(77);
  // Opponent breaking down their left wing, ball travelling up the pitch.
  world.possession = 'away';
  world.controllerId = null;
  world.ball.pos = { x: 0, y: BALL_RADIUS, z: -20 };
  world.ball.vel = { x: -18, y: 0, z: 0 };

  const ranked = rankSwitchCandidates(world);
  if (ranked.length === 0) throw new Error('no switch candidates');
  if (ranked.some((c) => world.players.find((p) => p.id === c.id)?.role === 'GK')) {
    throw new Error('the keeper was offered as a switch candidate in open play');
  }
  if (ranked.some((c) => c.id === world.activeId)) {
    throw new Error('the currently controlled player was offered as a candidate');
  }

  // The best pick must be closer to where the ball is heading than the average of the squad.
  const ahead = predictedBall(world, world.tuning.switching.predictSeconds);
  const best = world.players.find((p) => p.id === ranked[0].id);
  if (!best) throw new Error('ranked a player who does not exist');
  const bestGap = Math.hypot(best.pos.x - ahead.x, best.pos.z - ahead.z);
  const outfield = world.players.filter((p) => p.side === 'home' && p.role !== 'GK');
  const meanGap =
    outfield.reduce((sum, p) => sum + Math.hypot(p.pos.x - ahead.x, p.pos.z - ahead.z), 0) /
    outfield.length;
  if (bestGap >= meanGap) {
    throw new Error(
      `switch picked a player ${bestGap.toFixed(1)}m from the ball's path, worse than the ${meanGap.toFixed(1)}m squad average`,
    );
  }

  // Cycling: three presses inside the window must produce three different players.
  const picked = new Set<number>();
  for (let i = 0; i < 3; i++) {
    world.switching.sincePress = 0.2; // inside the cycle window, outside the debounce
    requestSwitch(world);
    picked.add(world.activeId);
  }
  if (picked.size < 3) {
    throw new Error(`cycling produced only ${picked.size} distinct players, expected 3`);
  }
  console.log(`switching checks passed (${ranked.length} candidates, cycled ${picked.size})`);
}

/** Throw-ins, corners and goal kicks must stop play, then be taken so the match restarts. */
function checkRestarts(): void {
  const cases: { name: string; pos: { x: number; y: number; z: number }; kind: string }[] = [
    { name: 'throw-in', pos: { x: 0, y: BALL_RADIUS, z: HALF_WIDTH + 1 }, kind: 'throw-in' },
    { name: 'corner', pos: { x: HALF_LENGTH + 1, y: BALL_RADIUS, z: 12 }, kind: 'corner' },
    { name: 'goal kick', pos: { x: HALF_LENGTH + 1, y: BALL_RADIUS, z: 12 }, kind: 'goal-kick' },
  ];
  for (const test of cases) {
    const world = newWorld(21);
    world.phase = 'in-play';
    const attacker = outfield(world, world.attackDir.home === 1 ? 'home' : 'away');
    const defender = outfield(world, world.attackDir.home === 1 ? 'away' : 'home');
    // The last touch decides between a corner and a goal kick.
    const toucher = test.kind === 'goal-kick' ? attacker : defender;
    world.lastTouch = { side: toucher.side, playerId: toucher.id };
    world.ball.pos = { ...test.pos };
    world.ball.vel = { x: 0, y: 0, z: 0 };

    run(world, TICK_DT);
    if (world.phase !== 'restart' || world.restart?.kind !== test.kind) {
      throw new Error(
        `${test.name}: expected a ${test.kind}, got ${world.restart?.kind ?? 'none'}`,
      );
    }

    // The CPU should line up and then put the ball back in play on its own.
    const events = run(world, 8);
    if (!events.some((e) => e === 'pass' || e === 'kick' || e === 'shot')) {
      throw new Error(`${test.name}: was never taken`);
    }
  }
  console.log(`set-piece restart checks passed (${cases.length} restarts)`);
}

/** A foul in the box is a penalty, and the CPU taker must strike it at goal. */
function checkPenalty(): void {
  const world = newWorld(33);
  world.phase = 'in-play';
  const attacking: 'home' | 'away' = 'away';
  const victim = outfield(world, attacking);
  const offender = outfield(world, 'home');
  const dir = world.attackDir[attacking];
  victim.pos = { x: (HALF_LENGTH - PENALTY_BOX_DEPTH / 2) * dir, z: 3 };
  offender.pos = { x: victim.pos.x, z: victim.pos.z + 0.5 };

  awardFoul(world, offender, victim, { severity: 0.3 });
  if (world.restart?.kind !== 'penalty') {
    throw new Error(`foul in the box gave a ${world.restart?.kind ?? 'nothing'}`);
  }
  if (world.stats.home.fouls !== 1) throw new Error('the foul was not counted');

  const events = run(world, 8);
  if (!events.includes('shot')) throw new Error('the penalty was never struck at goal');
  console.log('penalty check passed');
}

/** A pass to a player beyond the second-last defender must be flagged and punished. */
function checkOffside(): void {
  const world = newWorld(41);
  world.phase = 'in-play';
  world.offsideActive = true;
  const attack = world.attackDir.home;
  const passer = outfield(world, 'home');
  const runner = world.players.find(
    (p) => p.side === 'home' && p.role !== 'GK' && p.id !== passer.id,
  );
  if (!runner) throw new Error('no runner');
  passer.pos = { x: 10 * attack, z: 0 };
  world.ball.pos = { x: passer.pos.x, y: BALL_RADIUS, z: passer.pos.z };
  // Everyone but the keeper is behind the runner, so he is clearly beyond the last man.
  for (const p of world.players) {
    if (p.side === 'away' && p.role !== 'GK') p.pos = { x: 5 * attack, z: p.pos.z };
  }
  runner.pos = { x: 42 * attack, z: 4 };

  flagOffsides(world, passer);
  if (!runner.offside) throw new Error('the runner was not flagged offside');

  whistleOffside(world, runner);
  if (world.stats.home.offsides !== 1) throw new Error('the offside was not counted');
  if (world.restart?.kind !== 'free-kick' || world.restart.side !== 'away') {
    throw new Error('an offside did not award a free kick the other way');
  }
  console.log('offside check passed');
}

/** Two yellows is a red, and a sent-off player leaves the pitch for good. */
function checkCards(): void {
  const world = newWorld(53);
  const offender = outfield(world, 'away');
  book(world, offender);
  if (world.stats.away.yellows !== 1 || offender.sentOff) throw new Error('first yellow is wrong');
  book(world, offender);
  if (!offender.sentOff || world.stats.away.reds !== 1) {
    throw new Error('a second yellow did not produce a red card');
  }
  if (matchRating(offender) >= 6.5) throw new Error('a sending off should hurt the rating');
  console.log('card check passed');
}

/** A shot on target must draw the keeper into a dive or a save. */
function checkKeeper(): void {
  const world = newWorld(67);
  world.phase = 'in-play';
  const attack = world.attackDir.home;
  const striker = outfield(world, 'home');
  striker.pos = { x: (HALF_LENGTH - 16) * attack, z: 4 };
  world.ball.pos = { x: striker.pos.x, y: BALL_RADIUS, z: striker.pos.z };
  world.ball.vel = { x: 0, y: 0, z: 0 };
  const keeper = world.players.find((p) => p.side === 'away' && p.role === 'GK');
  if (!keeper) throw new Error('no keeper');
  keeper.pos = { x: (HALF_LENGTH - 1) * attack, z: 0 };
  // Nobody else is near enough to block it, so this is purely the keeper's ball.
  for (const p of world.players) {
    if (p.id !== striker.id && p.id !== keeper.id) p.pos = { x: -20 * attack, z: p.pos.z };
  }
  applyKick(world, striker, { x: attack, z: -0.26 }, 22, 0.5);

  const events = run(world, 3);
  const dived = keeper.diveDir !== 0 || keeper.anim === 'dive';
  if (!events.includes('save') && !dived && world.stats.away.saves === 0) {
    throw new Error('the keeper ignored a shot on target');
  }
  console.log('goalkeeper check passed');
}

/** Skill moves have to actually knock the ball somewhere and commit the dribbler. */
function checkSkills(): void {
  const world = newWorld(71);
  world.phase = 'in-play';
  const dribbler = outfield(world, 'home');
  dribbler.pos = { x: 0, z: 0 };
  dribbler.heading = Math.PI / 2;
  dribbler.dribbling = 85;
  world.ball.pos = { x: 0.4, y: BALL_RADIUS, z: 0 };
  world.ball.vel = { x: 0, y: 0, z: 0 };
  world.controllerId = dribbler.id;
  world.possession = 'home';

  if (!performSkill(world, dribbler, 'knock-on', { x: 1, z: 0 })) {
    throw new Error('the skill move was refused');
  }
  if (Math.hypot(world.ball.vel.x, world.ball.vel.z) < 1) {
    throw new Error('the skill move did not move the ball');
  }
  if (dribbler.skillTimer <= 0) throw new Error('the skill move did not commit the dribbler');
  console.log('skill move check passed');
}

/** A curled kick has to leave side-spin on the ball for the renderer's Magnus force. */
function checkCurl(): void {
  const world = newWorld(79);
  const striker = outfield(world, 'home');
  applyKick(world, striker, { x: 1, z: 0 }, 22, 3, 14);
  if (world.ball.spin.y !== 14) throw new Error('curl was not stored on the ball');
  applyKick(world, striker, { x: 1, z: 0 }, 22, 0);
  if (world.ball.spin.y !== 0) throw new Error('a flat kick should clear the spin');
  console.log('ball curl check passed');
}

const matches = Number(process.argv[2] ?? 3);
checkKickAndReset();
console.log('kick + reset checks passed');
checkHumanControls();
checkPassPower();
checkPassCompletion();
checkSwitchOnPass();
checkSwitching();
checkRestarts();
checkPenalty();
checkOffside();
checkCards();
checkKeeper();
checkSkills();
checkCurl();

let goals = 0;
for (let i = 0; i < matches; i++) {
  const difficulty: Difficulty = (['beginner', 'normal', 'hard', 'legendary'] as const)[i % 4];
  const result = playMatch(i * 31 + 5, difficulty, 240);
  goals += result.score.home + result.score.away;
  console.log(
    `match ${i + 1} (${difficulty}): ${result.score.home}-${result.score.away} ` +
      `shots ${result.shots.home}-${result.shots.away} ` +
      `possession ${result.possession.home}/${result.possession.away} ` +
      `goals(${JSON.stringify(result.goalKinds)}) ` +
      `${result.ticks} ticks in ${result.seconds.toFixed(2)}s`,
  );
}

if (goals === 0) throw new Error('no goals were scored across the simulated matches');
console.log(`ok: ${goals} goals across ${matches} simulated matches`);
