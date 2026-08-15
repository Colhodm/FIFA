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
  CENTER_CIRCLE_RADIUS,
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
  resetToKickoff,
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
  /** Where the striker stands, in attacking coordinates. Shots need a shooting position. */
  fromX?: number;
}

const CONTROL_CASES: ControlCase[] = [
  { name: 'ground pass', action: 'pass', minSpeed: 6 },
  { name: 'lofted pass', action: 'pass', doubleTap: true, minSpeed: 6, lofted: true },
  { name: 'driven pass', action: 'pass', mods: ['modR1'], minSpeed: 10 },
  { name: 'through ball', action: 'through', minSpeed: 8 },
  { name: 'lobbed through ball', action: 'through', mods: ['modL1'], minSpeed: 8, lofted: true },
  { name: 'cross', action: 'cross', minSpeed: 10, lofted: true },
  { name: 'driven cross', action: 'cross', mods: ['modR1'], minSpeed: 12, lofted: true },
  // From a real shooting position: a shot from the halfway line has to be lofted to reach.
  { name: 'shot', action: 'shoot', minSpeed: 14, charge: 1, fromX: 34 },
  { name: 'chip shot', action: 'shoot', mods: ['modL1'], minSpeed: 8, lofted: true, fromX: 34 },
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
    active.pos = { x: test.fromX ?? -6, z: 0 };
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
    // A shot now flies a solved arc rather than skidding along the grass, so it has to be
    // launched high enough to beat the drop over its flight. Passes stay genuinely flat.
    const lowBallLimit = test.action === 'shoot' ? 6.5 : 2.5;
    if (!test.lofted && vy > lowBallLimit) {
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
  let open = 0;
  let contested = 0;
  let openDone = 0;
  let contestedDone = 0;
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
        /*
         * Half the trials put the marker squarely in the passing lane rather than four metres
         * off it. With him only ever beside the receiver this was an unopposed drill, so it
         * scored ~99% no matter how good or bad interception was — the completion figure was
         * really measuring whether passes were correctly weighted, not whether they could be
         * cut out.
         */
        const inLane = s % 2 === 1;
        if (inLane) contested++;
        else open++;
        marker.pos = inLane ? { x: gap * dir * 0.55, z: 0.9 } : { x: gap * dir, z: 4 };
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
            if (holder.side === 'home') {
              completed++;
              if (inLane) contestedDone++;
              else openDone++;
            }
            break;
          }
          if (world.phase !== 'in-play') break;
        }
      }
    }
  }
  const pct = Math.round((completed / total) * 100);
  const openPct = Math.round((openDone / Math.max(1, open)) * 100);
  const contestedPct = Math.round((contestedDone / Math.max(1, contested)) * 100);
  console.log(
    `pass completion: ${openPct}% with a clear lane, ${contestedPct}% through a defender ` +
      `(${pct}% overall of ${total})`,
  );
  // Two different things, and averaging them hides both. A clear lane should nearly always find
  // its man now that passes are weighted to arrive; a ball played straight through a defender
  // should usually not.
  if (openPct < 85) throw new Error(`only ${openPct}% completed with a clear lane`);
  if (contestedPct > 45) {
    throw new Error(`${contestedPct}% completed straight through a defender — not interceptable`);
  }
  // Real completion from open play is 70-85%. The old floor of 80% with no ceiling quietly
  // enshrined a bug: completion had reached 100% because opponents could not physically touch a
  // firm pass, and a test that only checks for "high enough" will never catch that.
  console.log('pass completion check passed');
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
 * Block rate telemetry. Real block rates on shots from open play run about 25-30%; much higher
 * than that means defenders are reading the trajectory with superhuman latency, or are packed
 * into the shooting lane, and shots stop feeling earned. This measures it instead of arguing.
 */
function checkBlockRate(): void {
  let shots = 0;
  let blocked = 0;
  let reboundRatio = 0;
  let intercepted = 0;
  const fell: Record<string, number> = { attacker: 0, defender: 0, outOfPlay: 0, nobody: 0 };

  for (let s = 0; s < 40; s++) {
    const world = newWorld(s * 29 + 11);
    world.phase = 'in-play';
    world.offsideActive = false;
    const dir = world.attackDir.home;
    const me = world.players.find((p) => p.id === world.activeId);
    if (!me) throw new Error('no shooter');
    me.pos = { x: (52.5 - 17) * dir, z: (s % 7) - 3 };
    me.vel = { x: 0, z: 0 };
    me.kickCooldown = 0;
    world.ball.pos = { x: me.pos.x + 0.4 * dir, y: BALL_RADIUS, z: me.pos.z };
    world.ball.vel = { x: 0, y: 0, z: 0 };
    world.controllerId = me.id;
    world.possession = 'home';
    world.commands.length = 0;

    const mgr = manager();
    const actions = idleActions();
    actions.shoot = { ...actions.shoot, released: true, fired: true, charge: 1, heldTime: 1.2 };
    let before = { ...world.ball.vel };
    tick(world, { move: { x: -dir, z: 0 }, flick: { x: 0, z: 0 }, actions }, 0, TICK_DT, mgr);
    stepBall(world, TICK_DT, before);
    world.events.length = 0;
    shots++;
    const struckAt = Math.hypot(world.ball.vel.x, world.ball.vel.z);

    let wasBlocked = false;
    let reboundSpeed = 0;
    let settled = 'nobody';
    for (let i = 0; i < 60 * 4; i++) {
      before = { ...world.ball.vel };
      tick(world, idleInput, 0, TICK_DT, mgr);
      stepBall(world, TICK_DT, before);
      world.events.length = 0;
      const t = world.lastTouch;
      // Only contacts while the ball is still travelling at shot pace count. Without this the
      // metric drifts into "a defender eventually picked the ball up", which is neither a block
      // nor an interception of the shot.
      const live = world.shotAge < 1.2 && Math.hypot(world.ball.vel.x, world.ball.vel.z) > 12;
      if (!wasBlocked && live && t && t.side === 'away') {
        const man = world.players.find((p) => p.id === t.playerId);
        // A defender who *controls* the ball has intercepted it, not blocked it. Counting those
        // as blocks inflated the rate and dragged the measured rebound pace towards zero, because
        // a controlled ball is by definition stopped.
        if (man && man.role !== 'GK' && world.controllerId !== man.id) {
          wasBlocked = true;
          blocked++;
          reboundSpeed = Math.hypot(world.ball.vel.x, world.ball.vel.z);
        } else if (man && man.role !== 'GK') {
          intercepted++;
          break;
        }
      }
      if (wasBlocked) {
        // Who ends up with the rebound?
        if (world.phase !== 'in-play') {
          settled = 'outOfPlay';
          break;
        }
        const owner = world.players.find((p) => p.id === world.controllerId);
        if (owner && owner.id !== t?.playerId) {
          settled = owner.side === 'home' ? 'attacker' : 'defender';
          break;
        }
      } else if (world.phase !== 'in-play') {
        break;
      }
    }
    if (wasBlocked) {
      reboundRatio += struckAt > 0 ? reboundSpeed / struckAt : 0;
      fell[settled] += 1;
    }
  }

  const pct = Math.round((blocked / shots) * 100);
  const pace = blocked ? Math.round((reboundRatio / blocked) * 100) : 0;
  console.log(
    `block rate: ${pct}% of ${shots} shots from the edge of the box (real: 25-30%)\n` +
      `  ${intercepted} intercepted cleanly | rebound keeps ${pace}% of the shot's pace | falls to ` +
      Object.entries(fell)
        .map(([k, v]) => `${k} ${v}`)
        .join(', '),
  );
  if (pct > 55) throw new Error(`defenders block ${pct}% of shots, which is not football`);
  // A block that reliably kills the ball dead is the bug this telemetry exists to catch.
  if (blocked >= 5 && pace < 12) {
    throw new Error(`blocked shots retain only ${pace}% of their pace — deflections are dead`);
  }
}

/**
 * Ten yards. The laws make the defending side retreat 9.15m at a free kick or a corner; none of
 * it was modelled, so defenders stood wherever they happened to be, often on top of the ball.
 */
function checkTenYards(): void {
  for (const kind of ['free-kick', 'corner'] as const) {
    let encroaching = 0;
    let samples = 0;
    for (let seed = 0; seed < 8; seed++) {
      const world = newWorld(seed * 61 + 5);
      const dir = world.attackDir.home;
      const spot =
        kind === 'corner'
          ? { x: (HALF_LENGTH - 0.4) * dir, z: HALF_WIDTH - 0.4 }
          : { x: 20 * dir, z: 6 };
      world.phase = 'restart';
      world.restart = { kind, side: 'home', spot, autoTake: 3, takerId: null };
      world.ball.pos = { x: spot.x, y: BALL_RADIUS, z: spot.z };
      world.ball.vel = { x: 0, y: 0, z: 0 };
      world.controllerId = null;

      const mgr = manager();
      // Give them a moment to back off, as they would while the referee walks it out.
      for (let i = 0; i < 90; i++) {
        const before = { ...world.ball.vel };
        tick(world, idleInput, 0, TICK_DT, mgr);
        stepBall(world, TICK_DT, before);
        world.events.length = 0;
        if (world.phase !== 'restart') break;
      }
      for (const p of world.players) {
        if (p.side === 'home' || p.role === 'GK' || p.sentOff) continue;
        samples++;
        if (Math.hypot(p.pos.x - spot.x, p.pos.z - spot.z) < 8.4) encroaching++;
      }
    }
    const pct = Math.round((encroaching / Math.max(1, samples)) * 100);
    console.log(`${kind}: ${pct}% of defenders still inside ten yards`);
    if (pct > 20) throw new Error(`${pct}% of defenders encroach at a ${kind}`);
  }
}

/**
 * Driven, finesse and chip must be three genuinely different shots. The chip in particular was
 * broken: the solver had been forced onto the low arc to stop it lobbing ordinary shots, but a
 * chip is *defined* by looping the keeper, so it came out as a flat drive at waist height.
 */
function checkShotStyles(): void {
  const run = (mods: ('modR1' | 'modL1')[]) => {
    let peakSum = 0;
    let speedSum = 0;
    let n = 0;
    for (let seed = 0; seed < 10; seed++) {
      const world = newWorld(seed * 59 + 3);
      world.phase = 'in-play';
      world.offsideActive = false;
      const dir = world.attackDir.home;
      const me = world.players.find((p) => p.id === world.activeId);
      if (!me) throw new Error('no shooter');
      me.pos = { x: (52.5 - 18) * dir, z: 0 };
      me.vel = { x: 0, z: 0 };
      me.kickCooldown = 0;
      world.ball.pos = { x: me.pos.x + 0.4 * dir, y: BALL_RADIUS, z: 0 };
      world.ball.vel = { x: 0, y: 0, z: 0 };
      world.controllerId = me.id;
      world.possession = 'home';

      const mgr = manager();
      const actions = idleActions();
      actions.shoot = { ...actions.shoot, released: true, fired: true, charge: 1, heldTime: 1.2 };
      for (const m of mods) actions[m] = { ...actions[m], down: true };
      let before = { ...world.ball.vel };
      tick(world, { move: { x: dir, z: 0 }, flick: { x: 0, z: 0 }, actions }, 0, TICK_DT, mgr);
      stepBall(world, TICK_DT, before);
      world.events.length = 0;
      speedSum += Math.hypot(world.ball.vel.x, world.ball.vel.y, world.ball.vel.z);
      n++;

      let peak = 0;
      for (let i = 0; i < 60 * 3; i++) {
        before = { ...world.ball.vel };
        tick(world, idleInput, 0, TICK_DT, mgr);
        stepBall(world, TICK_DT, before);
        world.events.length = 0;
        peak = Math.max(peak, world.ball.pos.y);
        if (world.phase !== 'in-play') break;
      }
      peakSum += peak;
    }
    return { peak: +(peakSum / n).toFixed(1), speed: +(speedSum / n).toFixed(1) };
  };

  const driven = run([]);
  const finesse = run(['modR1']);
  const chip = run(['modL1']);
  console.log(
    `shot styles: driven ${driven.speed}m/s peak ${driven.peak}m | ` +
      `finesse ${finesse.speed}m/s peak ${finesse.peak}m | chip ${chip.speed}m/s peak ${chip.peak}m`,
  );
  if (finesse.speed >= driven.speed * 0.95) {
    throw new Error(`finesse (${finesse.speed}) is not slower than driven (${driven.speed})`);
  }
  if (chip.peak <= driven.peak * 1.6) {
    throw new Error(`a chip only reached ${chip.peak}m against a driven shot's ${driven.peak}m`);
  }
}

/**
 * Stamina has to come back. Recovery only happened when a player was standing perfectly still and
 * *jogging drained it*, so across ninety minutes stamina fell monotonically and anyone who had
 * sprinted was finished for the rest of the match.
 */
function checkStaminaRecovery(): void {
  const world = newWorld(21);
  world.phase = 'in-play';
  const me = world.players.find((p) => p.id === world.activeId);
  if (!me) throw new Error('no player');
  const mgr = manager();
  const drive = (sprint: boolean, seconds: number) => {
    const actions = idleActions();
    actions.sprint = { ...actions.sprint, down: sprint };
    for (let i = 0; i < 60 * seconds; i++) {
      const before = { ...world.ball.vel };
      tick(world, { move: { x: 1, z: 0 }, flick: { x: 0, z: 0 }, actions }, 0, TICK_DT, mgr);
      stepBall(world, TICK_DT, before);
      world.events.length = 0;
    }
  };
  // Sprint him into the ground, then jog for a while.
  drive(true, 25);
  const drained = +me.stamina.toFixed(2);
  drive(false, 30);
  const recovered = +me.stamina.toFixed(2);
  console.log(`stamina: ${drained} after a 25s sprint, ${recovered} after 30s of jogging`);
  if (drained > 0.75) throw new Error(`sprinting barely cost anything: ${drained}`);
  if (recovered <= drained + 0.05) {
    throw new Error(`stamina did not recover while jogging: ${drained} -> ${recovered}`);
  }
}

/**
 * Body feints must move the *defender* without moving the ball. Every other skill move shoves the
 * ball a metre or two, so there was no way to sell a direction and keep it under your foot.
 */
function checkBodyFeints(): void {
  let ballMoved = 0;
  let beaten = 0;
  let trials = 0;
  for (const move of ['feint-left', 'feint-right'] as const) {
    for (let seed = 0; seed < 12; seed++) {
      const world = newWorld(seed * 53 + 7);
      world.phase = 'in-play';
      const me = world.players.find((p) => p.id === world.activeId);
      if (!me) throw new Error('no carrier');
      me.pos = { x: 0, z: 0 };
      me.vel = { x: 0, z: 0 };
      me.dribbling = 85;
      me.skillTimer = 0;
      world.ball.pos = { x: 0.4, y: BALL_RADIUS, z: 0 };
      world.ball.vel = { x: 0, y: 0, z: 0 };
      world.controllerId = me.id;
      world.possession = 'home';
      const foe = world.players.find((p) => p.side === 'away' && p.role !== 'GK');
      if (!foe) throw new Error('no defender');
      foe.pos = { x: 2, z: 0 };
      foe.vel = { x: 4, z: 0 };
      foe.kickCooldown = 0;

      const from = { x: world.ball.pos.x, z: world.ball.pos.z };
      const ok = performSkill(world, me, move, { x: 1, z: move === 'feint-right' ? 1 : -1 });
      if (!ok) throw new Error(`${move} refused`);
      trials++;
      // The ball should still be at his feet.
      const shifted = Math.hypot(world.ball.pos.x - from.x, world.ball.pos.z - from.z);
      const launched = Math.hypot(world.ball.vel.x, world.ball.vel.z);
      if (launched > 4) ballMoved++;
      void shifted;
      if (foe.kickCooldown > 0.2) beaten++;
    }
  }
  console.log(
    `body feints: ball left the foot on ${ballMoved}/${trials}, defender wrong-footed ${beaten}/${trials}`,
  );
  if (ballMoved > trials * 0.25) {
    throw new Error(
      `a body feint launched the ball on ${ballMoved}/${trials} — that is a touch, not a feint`,
    );
  }
  if (beaten < trials * 0.5) {
    throw new Error(`body feints wrong-footed the defender only ${beaten}/${trials} times`);
  }
}

/**
 * A cross has to be aerial and it has to reach the box even off a short hold. Speed used to come
 * from hold time and *then* get split into a launch angle, so a light press produced about six
 * metres per second of horizontal pace and the ball dropped after eight metres.
 */
function checkCrossing(): void {
  const rows: string[] = [];
  for (const charge of [0.2, 0.6, 1]) {
    let inBox = 0;
    let peakSum = 0;
    let trials = 0;
    for (let seed = 0; seed < 10; seed++) {
      const world = newWorld(seed * 47 + 13);
      world.phase = 'in-play';
      world.offsideActive = false;
      const dir = world.attackDir.home;
      const me = world.players.find((p) => p.id === world.activeId);
      if (!me) throw new Error('no crosser');
      // Wide, level with the edge of the box: the classic crossing position.
      me.pos = { x: (52.5 - 16) * dir, z: 30 };
      me.vel = { x: 0, z: 0 };
      me.kickCooldown = 0;
      world.ball.pos = { x: me.pos.x + 0.4 * dir, y: BALL_RADIUS, z: 30 };
      world.ball.vel = { x: 0, y: 0, z: 0 };
      world.controllerId = me.id;
      world.possession = 'home';
      // Somebody has to be attacking the cross, or it is aimed at whoever happens to be nearest
      // in the kickoff shape — which is what the first version of this check was measuring.
      const striker = world.players.find(
        (q) => q.side === 'home' && q.role === 'FW' && q.id !== me.id,
      );
      if (striker) {
        striker.pos = { x: (52.5 - 10) * dir, z: 1 };
        striker.vel = { x: 0, z: 0 };
      }

      const mgr = manager();
      const actions = idleActions();
      actions.cross = { ...actions.cross, released: true, fired: true, charge, heldTime: charge };
      let before = { ...world.ball.vel };
      tick(world, { move: { x: 0, z: -1 }, flick: { x: 0, z: 0 }, actions }, 0, TICK_DT, mgr);
      stepBall(world, TICK_DT, before);
      world.events.length = 0;
      trials++;

      let peak = 0;
      let reached = false;
      for (let i = 0; i < 60 * 4; i++) {
        before = { ...world.ball.vel };
        tick(world, idleInput, 0, TICK_DT, mgr);
        stepBall(world, TICK_DT, before);
        world.events.length = 0;
        peak = Math.max(peak, world.ball.pos.y);
        // Did it get into the box: within 16.5m of goal line and 20m wide.
        const intoBox =
          Math.abs(world.ball.pos.x) > 52.5 - PENALTY_BOX_DEPTH && Math.abs(world.ball.pos.z) < 20;
        if (intoBox) reached = true;
        if (world.phase !== 'in-play') break;
      }
      peakSum += peak;
      if (reached) inBox++;
    }
    const pct = Math.round((inBox / trials) * 100);
    const peak = +(peakSum / trials).toFixed(1);
    rows.push(`${Math.round(charge * 100)}% -> ${pct}% into the box, peak ${peak}m`);
    if (charge >= 0.2 && pct < 60) {
      throw new Error(
        `a ${Math.round(charge * 100)}% cross reached the box only ${pct}% of the time`,
      );
    }
    if (peak < 1.5) throw new Error(`crosses are not aerial: peak height ${peak}m`);
  }
  console.log(`crossing: ${rows.join(' | ')}`);
}

/**
 * Nobody may take the ball off you at kickoff. The laws give the kicking side the ball until it
 * is played; this was not modelled at all — the whistle went and the opposition charged the spot.
 */
function checkKickoffProtection(): void {
  let stolen = 0;
  let intruded = 0;
  for (let seed = 0; seed < 10; seed++) {
    const world = newWorld(seed * 41 + 9);
    resetToKickoff(world, 'home');
    world.phase = 'in-play';
    const mgr = manager();
    // Stand there and do nothing for a second and a half: the ball must still be ours.
    for (let i = 0; i < 90; i++) {
      const before = { ...world.ball.vel };
      tick(world, idleInput, 0, TICK_DT, mgr);
      stepBall(world, TICK_DT, before);
      world.events.length = 0;
      const holder = world.players.find((p) => p.id === world.controllerId);
      if (holder && holder.side === 'away') stolen++;
      if (
        world.kickoffProtected &&
        world.players.some(
          (p) => p.side === 'away' && Math.hypot(p.pos.x, p.pos.z) < CENTER_CIRCLE_RADIUS - 0.5,
        )
      ) {
        intruded++;
      }
    }
  }
  console.log(
    `kickoff: ball stolen on ${stolen} frames, opponents inside the circle on ${intruded}`,
  );
  if (stolen > 0) throw new Error(`the opposition took the ball at kickoff on ${stolen} frames`);
}

/**
 * A striker breaking in behind must be tracked. Marking used to pick whoever was *nearest* and
 * aim at his current position, so a centre-half would follow a midfielder drifting past him while
 * a striker ran through, and even when he did pick the right man he trailed him permanently.
 */
function checkRunnerMarking(): void {
  let tracked = 0;
  let goalSide = 0;
  let trials = 0;
  let gapSum = 0;
  for (let seed = 0; seed < 12; seed++) {
    const world = newWorld(seed * 37 + 3);
    world.phase = 'in-play';
    world.offsideActive = false;
    // Away are defending; home have the ball in midfield and a striker breaking.
    const dir = world.attackDir.home;
    const carrier = world.players.find((p) => p.id === world.activeId);
    const runner = world.players.find(
      (p) => p.side === 'home' && p.role === 'FW' && p.id !== carrier?.id,
    );
    if (!carrier || !runner) throw new Error('missing players');
    carrier.pos = { x: 0, z: 0 };
    carrier.vel = { x: 0, z: 0 };
    world.ball.pos = { x: 0.4 * dir, y: BALL_RADIUS, z: 0 };
    world.ball.vel = { x: 0, y: 0, z: 0 };
    world.controllerId = carrier.id;
    world.possession = 'home';
    // A decoy who wanders near the centre-halves: the man the old rule would chase.
    const decoy = world.players.find(
      (p) => p.side === 'home' && p.role === 'MF' && p.id !== carrier.id,
    );
    if (decoy) {
      decoy.pos = { x: 26 * dir, z: 6 };
      decoy.vel = { x: 0, z: 0 };
    }
    /*
     * Start him level with the last defender, which is what a run in behind actually is. Placing
     * him beyond the whole back line and then asking why nobody is goal-side is not a marking
     * test — no defender can recover from that, and the first version of this check was doing it.
     */
    const line = world.players
      .filter((q) => q.side === 'away' && q.role !== 'GK' && !q.sentOff)
      .reduce((deepest, q) => (q.pos.x * dir < deepest.pos.x * dir ? q : deepest));
    runner.pos = { x: line.pos.x - 1.5 * dir, z: -2 };
    runner.vel = { x: 7.5 * dir, z: 0 };

    const mgr = manager();
    for (let i = 0; i < 60 * 2; i++) {
      // Drive the run: he is sprinting, not deciding.
      runner.vel = { x: 7.5 * dir, z: 0 };
      runner.pos = { x: runner.pos.x + runner.vel.x * TICK_DT, z: runner.pos.z };
      const before = { ...world.ball.vel };
      tick(world, idleInput, 0, TICK_DT, mgr);
      stepBall(world, TICK_DT, before);
      world.events.length = 0;
    }
    // Who is closest to the runner, and is he between the runner and goal?
    const defs = world.players.filter((p) => p.side === 'away' && p.role !== 'GK' && !p.sentOff);
    const away = (q: { x: number; z: number }) =>
      Math.hypot(q.x - runner.pos.x, q.z - runner.pos.z);
    let nearest = defs[0];
    for (const d of defs) if (away(d.pos) < away(nearest.pos)) nearest = d;
    const gap = away(nearest.pos);
    gapSum += gap;
    trials++;
    if (gap < 6) tracked++;
    // Goal-side: nearer the goal the runner is attacking than the runner himself.
    if (nearest.pos.x * dir > runner.pos.x * dir) goalSide++;
  }
  const meanGap = +(gapSum / trials).toFixed(1);
  console.log(
    `runner marking: tracked within 6m on ${tracked}/${trials}, goal-side ${goalSide}/${trials}, mean gap ${meanGap}m`,
  );
  if (tracked < trials * 0.7) {
    throw new Error(`a striker running in behind was tracked only ${tracked}/${trials} times`);
  }
  // The binary "within 6m" passed even with the old nearest-man marking, which trailed the runner
  // by 4.8m on average — clean through. The gap is what actually distinguishes them.
  if (meanGap > 3.5) {
    throw new Error(`markers trail a runner by ${meanGap}m on average — he is through on goal`);
  }
}

/**
 * A light tap must still play a usable through ball. Speed used to come straight from hold time,
 * and a through ball is played twenty-odd metres into space, so anything short of a full charge
 * died on the spot and the mechanic was unusable.
 */
function checkThroughBallWeight(): void {
  const rows: string[] = [];
  for (const charge of [0.15, 0.5, 1]) {
    let reached = 0;
    let trials = 0;
    for (let s = 0; s < 10; s++) {
      const world = newWorld(s * 31 + 5);
      world.phase = 'in-play';
      world.offsideActive = false;
      const dir = world.attackDir.home;
      const me = world.players.find((p) => p.id === world.activeId);
      if (!me) throw new Error('no passer');
      const runner = world.players.find(
        (p) => p.side === 'home' && p.id !== me.id && p.role === 'FW',
      );
      if (!runner) throw new Error('no runner');
      for (const p of world.players) {
        if (p === me || p === runner) continue;
        p.pos = { x: -55 * dir, z: p.pos.z };
        p.vel = { x: 0, z: 0 };
      }
      me.pos = { x: 0, z: 0 };
      me.vel = { x: 0, z: 0 };
      me.kickCooldown = 0;
      // Runner breaking into space eighteen metres ahead.
      runner.pos = { x: 18 * dir, z: 3 };
      runner.vel = { x: 5 * dir, z: 0 };
      world.ball.pos = { x: 0.4 * dir, y: BALL_RADIUS, z: 0 };
      world.ball.vel = { x: 0, y: 0, z: 0 };
      world.controllerId = me.id;
      world.possession = 'home';

      const mgr = manager();
      const actions = idleActions();
      actions.through = {
        ...actions.through,
        released: true,
        fired: true,
        charge,
        heldTime: charge,
      };
      let before = { ...world.ball.vel };
      tick(world, { move: { x: dir, z: 0 }, flick: { x: 0, z: 0 }, actions }, 0, TICK_DT, mgr);
      stepBall(world, TICK_DT, before);
      world.events.length = 0;
      trials++;

      for (let i = 0; i < 60 * 4; i++) {
        before = { ...world.ball.vel };
        tick(world, idleInput, 0, TICK_DT, mgr);
        stepBall(world, TICK_DT, before);
        world.events.length = 0;
        if (world.controllerId === runner.id) {
          reached++;
          break;
        }
        if (world.phase !== 'in-play') break;
      }
    }
    rows.push(`${Math.round(charge * 100)}% charge -> ${Math.round((reached / trials) * 100)}%`);
    if (charge <= 0.15 && reached / trials < 0.5) {
      throw new Error(`a light through ball reached its runner only ${reached}/${trials} times`);
    }
  }
  console.log(`through balls reaching the runner: ${rows.join(' | ')}`);
}

/**
 * A 90 dribbler has to be *obviously* better than a 70, not marginally. Everything used to be
 * driven off `dribbling / 100`, which made the difference about 11%; you could not feel it.
 * This runs the same scripted slalom at each rating and reports the gap.
 */
function checkDribbleSkillGap(): void {
  const run = (rating: number) => {
    let strays = 0;
    let lost = 0;
    let gapSum = 0;
    let samples = 0;
    for (let seed = 0; seed < 8; seed++) {
      const world = newWorld(seed * 13 + 7);
      world.phase = 'in-play';
      world.offsideActive = false;
      const me = world.players.find((p) => p.id === world.activeId);
      if (!me) throw new Error('no carrier');
      me.dribbling = rating;
      me.pos = { x: 0, z: 0 };
      me.vel = { x: 0, z: 0 };
      me.kickCooldown = 0;
      // Alone with the ball: this measures control, not whether he beats anyone.
      for (const p of world.players) {
        if (p.id === me.id) continue;
        p.pos = { x: -60, z: p.pos.z > 0 ? 34 : -34 };
        p.vel = { x: 0, z: 0 };
      }
      world.ball.pos = { x: 0.4, y: BALL_RADIUS, z: 0 };
      world.ball.vel = { x: 0, y: 0, z: 0 };
      world.controllerId = me.id;
      world.possession = 'home';

      const mgr = manager();
      // Slalom: swing the stick through a wide arc so he has to keep turning the ball.
      for (let i = 0; i < 60 * 6; i++) {
        const t = i / 60;
        const ang = Math.sin(t * 2.1) * 1.15;
        const actions = idleActions();
        actions.sprint = { ...actions.sprint, down: t > 2 };
        const before = { ...world.ball.vel };
        tick(
          world,
          { move: { x: Math.sin(ang), z: Math.cos(ang) }, flick: { x: 0, z: 0 }, actions },
          0,
          TICK_DT,
          mgr,
        );
        stepBall(world, TICK_DT, before);
        world.events.length = 0;
        const gap = Math.hypot(me.pos.x - world.ball.pos.x, me.pos.z - world.ball.pos.z);
        gapSum += gap;
        samples++;
        if (gap > 2.6) strays++;
        if (world.controllerId !== me.id) lost++;
      }
    }
    return {
      meanGap: +(gapSum / samples).toFixed(2),
      strayedPct: Math.round((strays / samples) * 100),
      lostPct: Math.round((lost / samples) * 100),
    };
  };

  const poor = run(55);
  const good = run(70);
  const elite = run(90);
  console.log(
    `dribble skill: 55 -> gap ${poor.meanGap}m lost ${poor.lostPct}% | ` +
      `70 -> gap ${good.meanGap}m lost ${good.lostPct}% | ` +
      `90 -> gap ${elite.meanGap}m lost ${elite.lostPct}%`,
  );
  // An elite carrier must keep the ball meaningfully tighter than a good one.
  if (elite.meanGap >= good.meanGap * 0.9) {
    throw new Error(
      `a 90 dribbler holds the ball at ${elite.meanGap}m vs a 70 at ${good.meanGap}m — not a real gap`,
    );
  }
}

/**
 * Losing the ball has to hand you somebody who can defend. The switch is made before
 * `world.possession` catches up, so ranking used to think the team was still attacking and
 * ignored the goal-side term — handing over whichever forward happened to be nearest the ball
 * rather than a defender getting back.
 */
function checkDefensiveSwitch(): void {
  let goalSide = 0;
  let trials = 0;
  for (let s = 0; s < 20; s++) {
    const world = newWorld(s * 23 + 5);
    world.phase = 'in-play';
    const attack = world.attackDir.home;
    // We have just lost it in their half: the ball is upfield and breaking back at us.
    world.ball.pos = { x: 24 * attack, y: BALL_RADIUS, z: 6 };
    world.ball.vel = { x: -16 * attack, y: 0, z: 0 };
    world.possession = 'home';
    world.switching.sinceManual = 99;
    const thief = world.players.find((p) => p.side === 'away' && p.role !== 'GK');
    if (!thief) throw new Error('no opponent');
    thief.pos = { x: 24 * attack, z: 6 };

    const picked = rankSwitchCandidates(world, false, true)[0];
    if (!picked) continue;
    const man = world.players.find((p) => p.id === picked.id);
    if (!man || man.role === 'GK') throw new Error('defensive switch offered the keeper');
    trials++;
    // Goal-side means between the ball and our own goal, in attacking coordinates.
    if (man.pos.x * attack < world.ball.pos.x * attack) goalSide++;
  }
  const pct = Math.round((goalSide / trials) * 100);
  if (pct < 80) {
    throw new Error(`only ${pct}% of defensive switches gave a goal-side player, expected >= 80%`);
  }
  console.log(`defensive switch check passed (${pct}% goal-side across ${trials} turnovers)`);
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
checkDefensiveSwitch();
checkTenYards();
checkShotStyles();
checkStaminaRecovery();
checkBodyFeints();
checkCrossing();
checkKickoffProtection();
checkRunnerMarking();
checkThroughBallWeight();
checkDribbleSkillGap();
checkBlockRate();
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
