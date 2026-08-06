# Browser FIFA

A browser-based single-player football match against the CPU: pick two clubs, formations, difficulty
and half length, kick off, and play a full two-half match in 3D.

All clubs, players and kits are fictional placeholder data (`public/data/teams.json`) so the project
carries no licensed content. Swap that file to use your own data.

## Stack

React 19 · TypeScript · Vite · Three.js via React Three Fiber / Drei · Rapier physics · Zustand ·
Oxlint · Prettier.

## Getting started

```bash
nvm use            # Node 22 (see .nvmrc)
npm install
npm run dev        # http://localhost:5173
```

## Controls

| Action        | Keys                           |
| ------------- | ------------------------------ |
| Move          | `WASD` / arrow keys            |
| Sprint        | `Shift`                        |
| Pass          | `K` / `Space` (hold to charge) |
| Shoot         | `L` (hold to charge)           |
| Tackle        | `J`                            |
| Switch player | `Q` / `Tab`                    |
| Pause         | `Esc` / `P`                    |

Inputs go through an abstraction layer (`src/game/input`), so gamepad or touch schemes can be added
without touching gameplay code.

## Architecture

The match is a deterministic, renderer-agnostic simulation driven at a fixed 60 Hz timestep; the R3F
scene is a view over it.

```
src/game/sim      state.ts (world + snapshots) · step.ts (tick) · ai.ts (CPU) · rules.ts (restarts,
                  goals, halftime/fulltime) · kick.ts · math.ts
src/game/render   Scene, Pitch, Goals, Stadium, Players, Ball, ChaseCamera, Simulation (the loop)
src/game/input    keyboard bindings -> intent
src/game/audio    Web Audio kick/whistle/goal/crowd
src/game/perf     frame-time sampler -> adaptive pixel ratio, shadows, crowd density
src/ui            MainMenu, Hud, Match, FullTime
```

Rapier owns the ball only (dynamic body with CCD); players are kinematic bodies moved by the
simulation. Each tick the ball's Rapier transform is mirrored into `world.ball`, the sim emits
`BallCommand`s (impulses/velocities), and the physics layer applies them. `snapshot(world, tick)`
produces a fully serializable world state, which is what makes headless testing possible.

## Validation

```bash
npm run lint
npm run typecheck
npm run build
npm run sim -- 8     # headless AI-vs-AI matches (no browser, no Rapier)
```

`npm run sim` runs full matches through the same simulation the browser uses and asserts kickoff
placement, serializable snapshots, kick impulses, finite ball state, that every match reaches
fulltime, and that goals are actually scored.

## Data

`npm run teams` regenerates `public/data/teams.json` (fictional clubs, kits, squads and ratings).
