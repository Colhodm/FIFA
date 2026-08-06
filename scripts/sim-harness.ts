/**
 * Headless match harness: runs the simulation with a lightweight ball integrator instead of
 * Rapier so AI, rules and kick/reset logic can be validated in CI without a browser.
 *
 *   npx tsx scripts/sim-harness.ts [matches]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BALL_MASS, BALL_RADIUS, TICK_DT } from '../src/game/constants';
import type { ActionName, InputFrame } from '../src/game/input/input';
import { ACTIONS } from '../src/game/input/input';
import { createWorld, snapshot, type SimWorld } from '../src/game/sim/state';
import { tick } from '../src/game/sim/step';
import type { Difficulty, TeamsFile } from '../src/game/types';

const here = dirname(fileURLToPath(import.meta.url));
const teams = (
  JSON.parse(readFileSync(resolve(here, '../public/data/teams.json'), 'utf8')) as TeamsFile
).teams;

const idleActions = (): InputFrame['actions'] =>
  Object.fromEntries(
    ACTIONS.map((a) => [
      a,
      { down: false, pressed: false, released: false, heldTime: 0, doubleTap: false },
    ]),
  ) as InputFrame['actions'];

const idleInput: InputFrame = { move: { x: 0, z: 0 }, actions: idleActions() };

const GRAVITY = -9.81;
const RESTITUTION = 0.62;
const ROLL_DAMPING = 0.65;
const AIR_DAMPING = 0.32;

/** Minimal stand-in for the Rapier ball body: gravity, bounce, rolling friction. */
function stepBall(world: SimWorld, dt: number): void {
  const ball = world.ball;
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
    tick(world, idleInput, 0, TICK_DT);
    for (const event of world.events) {
      if (event.type === 'shot' || event.type === 'pass' || event.type === 'kick') {
        lastKick = { tick: ticks, type: event.type };
      } else if (event.type === 'goal') {
        const kind = ticks - lastKick.tick > 40 ? 'walked-in' : lastKick.type;
        goalKinds[kind] = (goalKinds[kind] ?? 0) + 1;
      }
    }
    stepBall(world, TICK_DT);
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
    tick(world, idleInput, 0, TICK_DT);
    kicked = world.commands.some((c) => c.type === 'impulse');
    stepBall(world, TICK_DT);
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
      down: false,
      pressed: false,
      released: true,
      heldTime: 0.35,
      doubleTap: test.doubleTap ?? false,
    };
    for (const mod of test.mods ?? []) {
      actions[mod] = { ...actions[mod], down: true };
    }
    tick(world, { move: { x: 1, z: 0 }, actions }, 0, TICK_DT);

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

const matches = Number(process.argv[2] ?? 3);
checkKickAndReset();
console.log('kick + reset checks passed');
checkHumanControls();

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
