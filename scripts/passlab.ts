/**
 * Deterministic pass laboratory: poses a passer, a receiver and a marker at fixed geometry,
 * plays a human pass at a known charge, and runs the simulation on until the ball settles.
 * Reports who ended up with it, over many seeds, so pass completion can be measured instead of
 * eyeballed from a noisy live match.
 *
 * Run: npm run passlab
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BALL_MASS, BALL_RADIUS, TICK_DT } from '../src/game/constants';
import { ACTIONS, InputManager, type InputFrame } from '../src/game/input/input';
import type { Vec3 } from '../src/game/sim/math';
import { createWorld, type SimWorld } from '../src/game/sim/state';
import { tick } from '../src/game/sim/step';
import type { TeamsFile } from '../src/game/types';

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

const GRAVITY = -9.81;
const RESTITUTION = 0.62;
const ROLL_DAMPING = 0.65;
const AIR_DAMPING = 0.32;

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
  const decay = Math.exp(-(grounded ? ROLL_DAMPING : AIR_DAMPING) * dt);
  ball.vel.x *= decay;
  ball.vel.z *= decay;
}

type Outcome = 'teammate' | 'intercepted' | 'nobody';

function trialVerbose(seed: number, gap: number, charge: number, mark: number) {
  return trialImpl(seed, gap, charge, mark, true);
}

/** One pass: receiver `gap` metres ahead, a marker `mark` metres off him. */
function trial(seed: number, gap: number, charge: number, mark: number): Outcome {
  return trialImpl(seed, gap, charge, mark, false).outcome;
}

function trialImpl(seed: number, gap: number, charge: number, mark: number, verbose: boolean) {
  const world = createWorld({
    homeTeam: teams[seed % teams.length],
    awayTeam: teams[(seed + 1) % teams.length],
    homeFormation: teams[seed % teams.length].formation,
    awayFormation: teams[(seed + 1) % teams.length].formation,
    humanSide: 'home',
    difficulty: 'normal',
    halfLength: 600,
    seed,
  });
  world.phase = 'in-play';
  const dir = world.attackDir.home;
  const me = world.players.find((p) => p.id === world.activeId)!;
  const mate = world.players.find((p) => p.side === 'home' && p.id !== me.id && p.role !== 'GK')!;
  const marker = world.players.find((p) => p.side === 'away' && p.role !== 'GK')!;

  // Park everyone irrelevant behind the passer.
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
  marker.pos = { x: gap * dir, z: mark };
  marker.vel = { x: 0, z: 0 };
  world.ball.pos = { x: 0.4 * dir, y: BALL_RADIUS, z: 0 };
  world.ball.vel = { x: 0, y: 0, z: 0 };
  world.controllerId = me.id;
  world.possession = 'home';
  world.commands.length = 0;

  const manager = new InputManager();
  const actions = idleActions();
  actions.pass = { ...actions.pass, released: true, fired: true, charge, heldTime: charge };
  const aim = { x: dir, z: 0 };
  const frame: InputFrame = { move: aim, flick: { x: 0, z: 0 }, actions };
  // cameraYaw 0 with the corrected transform maps stick -x to world +x.
  const stick = { x: -dir, z: 0 };
  frame.move = stick;

  const aimedAt = { x: mate.pos.x, z: mate.pos.z };
  let before = { ...world.ball.vel };
  tick(world, frame, 0, TICK_DT, manager);
  stepBall(world, TICK_DT, before);
  world.events.length = 0;

  const idle: InputFrame = { move: { x: 0, z: 0 }, flick: { x: 0, z: 0 }, actions: idleActions() };
  for (let i = 0; i < 60 * 5; i++) {
    before = { ...world.ball.vel };
    tick(world, idle, 0, TICK_DT, manager);
    stepBall(world, TICK_DT, before);
    world.events.length = 0;
    const holder = world.players.find((p) => p.id === world.controllerId);
    if (holder && holder.id !== me.id) {
      return {
        outcome: (holder.side === 'home' ? 'teammate' : 'intercepted') as Outcome,
        mateMoved: Math.hypot(mate.pos.x - aimedAt.x, mate.pos.z - aimedAt.z),
        ballToMate: Math.hypot(world.ball.pos.x - mate.pos.x, world.ball.pos.z - mate.pos.z),
      };
    }
    if (world.phase !== 'in-play') break;
  }
  void verbose;
  return {
    outcome: 'nobody' as Outcome,
    mateMoved: Math.hypot(mate.pos.x - aimedAt.x, mate.pos.z - aimedAt.z),
    ballToMate: Math.hypot(world.ball.pos.x - mate.pos.x, world.ball.pos.z - mate.pos.z),
  };
}

// Diagnostic: where do the 22 m passes actually end up?
{
  const counts: Record<string, number> = {};
  let mateMoved = 0,
    ballToMate = 0,
    n = 0;
  for (let s2 = 0; s2 < 30; s2++) {
    const r = trialVerbose(s2 * 13 + 7, 22, 1, 4);
    counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
    mateMoved += r.mateMoved;
    ballToMate += r.ballToMate;
    n++;
  }
  console.log(
    '22 m, full charge:',
    counts,
    `| receiver drifted ${(mateMoved / n).toFixed(1)} m from where the pass was aimed`,
    `| ball settled ${(ballToMate / n).toFixed(1)} m from him`,
  );
  console.log();
}

const gaps = [8, 15, 22, 30];
const charges = [0.25, 0.5, 0.75, 1];
const SEEDS = 30;

console.log('pass completion %, receiver marked from 4 m away\n');
const header = ['gap \\ charge', ...charges.map((c) => c.toFixed(2).padStart(6))].join('  ');
console.log(header);
let overall = 0;
let overallN = 0;
for (const gap of gaps) {
  const cells: string[] = [];
  for (const charge of charges) {
    let ok = 0;
    for (let s = 0; s < SEEDS; s++) {
      if (trial(s * 13 + 7, gap, charge, 4) === 'teammate') ok++;
    }
    overall += ok;
    overallN += SEEDS;
    cells.push(`${Math.round((ok / SEEDS) * 100)}%`.padStart(6));
  }
  console.log([`${gap} m`.padEnd(12), ...cells].join('  '));
}
console.log(`\noverall ${Math.round((overall / overallN) * 100)}% across ${overallN} passes`);
