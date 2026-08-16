/** Ad-hoc: verifies a tied knockout match goes to extra time and a penalty shootout. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BALL_MASS, BALL_RADIUS, TICK_DT } from '../src/game/constants';
import { ACTIONS, InputManager, type InputFrame } from '../src/game/input/input';
import { createWorld } from '../src/game/sim/state';
import { tick } from '../src/game/sim/step';
import type { TeamsFile } from '../src/game/types';

const here = dirname(fileURLToPath(import.meta.url));
const teams = (
  JSON.parse(readFileSync(resolve(here, '../public/data/teams.json'), 'utf8')) as TeamsFile
).teams;

const idleInput: InputFrame = {
  move: { x: 0, z: 0 },
  flick: { x: 0, z: 0 },
  actions: Object.fromEntries(
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
  ) as InputFrame['actions'],
};

const GRAVITY = -9.81;
function stepBall(
  world: ReturnType<typeof createWorld>,
  dt: number,
  before: { x: number; y: number; z: number },
): void {
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
    ball.vel.y = Math.abs(ball.vel.y) < 0.6 ? 0 : -ball.vel.y * 0.62;
  }
  const decay = Math.exp(-(grounded ? 0.65 : 0.32) * dt);
  ball.vel.x *= decay;
  ball.vel.z *= decay;
}

for (let seed = 1; seed <= 6; seed++) {
  const world = createWorld({
    homeTeam: teams[seed % teams.length],
    awayTeam: teams[(seed + 3) % teams.length],
    homeFormation: teams[seed % teams.length].formation,
    awayFormation: teams[(seed + 3) % teams.length].formation,
    humanSide: 'home',
    difficulty: 'normal',
    halfLength: 20,
    mode: 'knockout',
    seed,
  });
  let ticks = 0;
  let maxHalf = 1;
  while (world.phase !== 'end' && ticks < 60 * 60 * 30) {
    world.activeId = -1;
    const before = { ...world.ball.vel };
    tick(world, idleInput, 0, TICK_DT, new InputManager());
    stepBall(world, TICK_DT, before);
    world.events.length = 0;
    maxHalf = Math.max(maxHalf, world.half);
    ticks += 1;
  }
  if (world.phase !== 'end') throw new Error(`seed ${seed}: never ended`);
  const s = world.shootout;
  console.log(
    `seed ${seed}: ${world.score.home}-${world.score.away} maxHalf=${maxHalf}` +
      (s
        ? ` shootout ${s.scores.home}-${s.scores.away} taken ${s.taken.home}/${s.taken.away} winner=${s.winner}`
        : ''),
  );
  const tied = world.score.home === world.score.away;
  if (tied && (!s || !s.winner)) throw new Error(`seed ${seed}: tied but no shootout winner`);
  if (tied && maxHalf < 4) throw new Error(`seed ${seed}: tied but no extra time`);
}
console.log('knockout checks passed');
