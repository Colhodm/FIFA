import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { audio } from '../audio/audio';
import {
  BALL_MASS,
  CHARGE_TIME,
  HALF_LENGTH,
  MAGNUS,
  MAX_TICKS_PER_FRAME,
  SPIN_DECAY,
  TICK_DT,
} from '../constants';
import { CHARGED_ACTIONS } from '../input/input';
import { FrameSampler } from '../perf/quality';
import { padConnected, runtime, type ReplayFrame } from '../runtime';
import { cameraRelative, clamp } from '../sim/math';
import { speedFor } from '../sim/power';
import { matchMinute, stoppageMinutes } from '../sim/rules';
import type { SimWorld } from '../sim/state';
import { tick } from '../sim/step';
import { predictedBall, rankSwitchCandidates } from '../sim/switching';
import { useGameStore, useHudStore } from '../store';
import { poseRig } from './animation';

const HUD_INTERVAL = 0.1;
/** Seconds of play kept for goal replays. */
const REPLAY_SECONDS = 5;
const REPLAY_FPS = 30;
const REPLAY_CAPACITY = REPLAY_SECONDS * REPLAY_FPS;

/** Drives the fixed-timestep simulation, mirrors it onto the physics bodies and the HUD. */
export function Simulation({ world }: { world: SimWorld }) {
  const accumulator = useRef(0);
  const hudTimer = useRef(0);
  const replayTimer = useRef(0);
  const clock = useRef(0);
  const sampler = useMemo(() => new FrameSampler(), []);

  useFrame((_state, delta) => {
    const dt = Math.min(delta, 0.25);
    clock.current += dt;

    // Sampled from the true frame time, not the clamped simulation dt.
    const qualityStep = sampler.sample(delta);
    if (qualityStep !== 0) {
      const game = useGameStore.getState();
      if (game.quality === 'auto') game.setTier(game.tier.id + qualityStep);
    }

    if (useGameStore.getState().paused) return;

    // Mirror the authoritative physics state into the simulation.
    const body = runtime.ball;
    if (body) {
      const t = body.translation();
      const v = body.linvel();
      const r = body.rotation();
      world.ball.pos = { x: t.x, y: t.y, z: t.z };
      world.ball.vel = { x: v.x, y: v.y, z: v.z };
      world.ball.rot = [r.x, r.y, r.z, r.w];
    }

    accumulator.current += dt;
    let ticks = 0;
    while (accumulator.current >= TICK_DT && ticks < MAX_TICKS_PER_FRAME) {
      accumulator.current -= TICK_DT;
      ticks += 1;
      const frame = runtime.input.update(TICK_DT);
      tick(world, frame, runtime.cameraYaw, TICK_DT, runtime.input);
      if (frame.actions.pause.pressed) useGameStore.getState().setPaused(true);
      if (import.meta.env.DEV && frame.actions.debug.pressed) useGameStore.getState().toggleDebug();
      // Any of the four kick buttons fills the same power meter, and the meter shows the real
      // hold against that action's own maximum rather than a shared guess.
      let charge = 0;
      for (const action of CHARGED_ACTIONS) {
        const state = frame.actions[action];
        if (!state.down) continue;
        const limit = runtime.input.chargeLimits[action] ?? CHARGE_TIME;
        charge = Math.max(charge, clamp(state.heldTime / limit, 0, 1));
      }
      runtime.charge = charge;
    }
    if (import.meta.env.DEV && useGameStore.getState().debug) publishDebug(world);

    runtime.diag.frames += 1;
    runtime.diag.ticks += ticks;
    if (accumulator.current >= TICK_DT) runtime.diag.starvedFrames += 1;
    // Keep a frame's worth of backlog so a hitch is caught up on the next frame; drop anything
    // beyond that rather than zeroing, which used to throw away real time and stall the clock.
    accumulator.current = Math.min(accumulator.current, TICK_DT * MAX_TICKS_PER_FRAME);

    if (body) {
      for (const command of world.commands) {
        if (command.type === 'impulse') {
          body.applyImpulseAtPoint(command.impulse, command.point, true);
        } else if (command.type === 'velocity') {
          body.setLinvel(command.vel, true);
        } else {
          body.setTranslation(command.pos, true);
          body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        }
      }

      // Magnus effect: sidespin pushes the ball perpendicular to its flight, so a curled
      // cross bends towards the near post and a finesse shot wraps around the keeper.
      const spin = world.ball.spin;
      if (Math.abs(spin.y) > 0.05) {
        const v = world.ball.vel;
        const impulse = {
          x: MAGNUS * spin.y * v.z * BALL_MASS * dt,
          y: 0,
          z: -MAGNUS * spin.y * v.x * BALL_MASS * dt,
        };
        body.applyImpulse(impulse, true);
        // Spin also shows on the ball itself, and bleeds off through the flight.
        body.setAngvel({ x: -v.z * 1.4, y: spin.y, z: v.x * 1.4 }, false);
        spin.y *= Math.pow(SPIN_DECAY, dt);
        if (world.ball.pos.y < 0.2 && Math.hypot(v.x, v.z) < 4) spin.y = 0;
      }
    }
    world.commands.length = 0;

    for (const player of world.players) {
      const rb = runtime.bodies.get(player.id);
      if (rb) {
        rb.setNextKinematicTranslation({
          x: player.pos.x,
          // A sent-off player is dropped under the pitch rather than unmounted mid-match.
          y: player.sentOff ? -8 : player.height,
          z: player.pos.z,
        });
        rb.setNextKinematicRotation({
          x: 0,
          y: Math.sin(player.heading / 2),
          z: 0,
          w: Math.cos(player.heading / 2),
        });
      }
      const rig = runtime.visuals.get(player.id);
      if (rig) {
        rig.root.visible = !player.sentOff;
        poseRig(rig, player);
      }
    }

    const active = world.players.find((p) => p.id === world.activeId);
    if (runtime.indicator) {
      runtime.indicator.visible = Boolean(active) && !runtime.replay.playing;
      if (active) runtime.indicator.position.set(active.pos.x, 0.03, active.pos.z);
    }

    if (runtime.aim) {
      // Only the human taker gets an aim arrow, and only while the restart is live.
      const set = world.restart;
      const human =
        set && active && set.takerId === active.id && active.side === world.config.humanSide;
      runtime.aim.visible = Boolean(human);
      if (human && set) {
        const aimDir = cameraRelative(runtime.input.frame.move, runtime.cameraYaw);
        const heading =
          Math.hypot(aimDir.x, aimDir.z) > 0.2
            ? Math.atan2(aimDir.x, aimDir.z)
            : (active?.heading ?? 0);
        runtime.aim.position.set(set.spot.x, 0, set.spot.z);
        runtime.aim.rotation.set(0, heading, 0);
        runtime.aim.scale.setScalar(0.7 + runtime.charge * 0.8);
      }
    }

    recordReplay(world, dt, replayTimer);

    for (const event of world.events) {
      switch (event.type) {
        case 'kick':
        case 'pass':
        case 'shot':
          audio.kick(event.intensity ?? 0.6);
          break;
        case 'header':
          audio.kick((event.intensity ?? 0.6) * 0.7);
          break;
        case 'save':
          audio.save();
          break;
        case 'tackle':
        case 'skill':
          audio.tackle();
          break;
        case 'goal': {
          audio.goal();
          // Bulge the net where the ball crossed the line, and roll the replay.
          runtime.netHit = {
            dir: world.ball.pos.x > 0 ? 1 : -1,
            t: 0.9,
            z: world.ball.pos.z,
            y: clamp(world.ball.pos.y, 0.1, 2.3),
          };
          startReplay();
          break;
        }
        case 'foul':
        case 'offside':
          audio.whistle(0.7);
          break;
        case 'card':
          audio.whistle(0.9);
          break;
        case 'whistle':
          audio.whistle(0.5);
          break;
        case 'halftime':
          audio.whistle(1);
          break;
        case 'fulltime':
          audio.whistle(1.5);
          break;
        default:
          break;
      }
    }
    world.events.length = 0;

    playReplay(world, dt);

    hudTimer.current += dt;
    if (hudTimer.current < HUD_INTERVAL) return;
    hudTimer.current = 0;

    const goalDistance = Math.min(
      Math.hypot(HALF_LENGTH - world.ball.pos.x, world.ball.pos.z),
      Math.hypot(-HALF_LENGTH - world.ball.pos.x, world.ball.pos.z),
    );
    // The crowd lifts as the ball gets near a goal and erupts when one goes in.
    audio.setCrowdIntensity(world.phase === 'goal' ? 1 : clamp(1 - goalDistance / 48, 0.05, 0.95));

    const total = world.possessionTicks.home + world.possessionTicks.away || 1;
    useHudStore.getState().set({
      phase: world.phase,
      half: world.half,
      minute: matchMinute(world),
      stoppage: stoppageMinutes(world),
      score: { ...world.score },
      banner: world.banner,
      activeName: active?.name ?? '',
      activeShirt: active?.shirt ?? 0,
      stamina: active?.stamina ?? 1,
      possession: {
        home: Math.round((world.possessionTicks.home / total) * 100),
        away: Math.round((world.possessionTicks.away / total) * 100),
      },
      shots: { ...world.shots },
      stats: { home: { ...world.stats.home }, away: { ...world.stats.away } },
      feed: [...world.feed],
      setPiece: world.restart ? world.restart.kind : null,
      replay: runtime.replay.playing,
      pad: padConnected(),
      fps: Math.round(sampler.fps),
      tierName: useGameStore.getState().tier.name,
      charge: runtime.charge,
    });
  });

  return null;
}

/**
 * Fills `runtime.debug` for the F1 overlay. Everything here is derived from the same pure
 * functions gameplay uses, so the overlay cannot disagree with what the match is doing.
 */
function publishDebug(world: SimWorld): void {
  const manager = runtime.input;
  const frame = manager.frame;
  const debug = runtime.debug;

  debug.raw = { ...frame.move };
  debug.world = cameraRelative(frame.move, runtime.cameraYaw);
  debug.context = manager.context;
  debug.buffered = manager.buffer?.action ?? null;
  debug.bufferAge = manager.buffer?.age ?? 0;
  debug.candidates = rankSwitchCandidates(world).slice(0, 3);
  debug.predicted = predictedBall(world, world.tuning.switching.predictSeconds);

  debug.charge = 0;
  debug.chargeAction = null;
  for (const action of CHARGED_ACTIONS) {
    const state = frame.actions[action];
    const limit = manager.chargeLimits[action] ?? CHARGE_TIME;
    if (state.down) {
      const live = clamp(state.heldTime / limit, 0, 1);
      if (live >= debug.charge) {
        debug.charge = live;
        debug.chargeAction = action;
        debug.holdSeconds = state.heldTime;
      }
    }
    // Record the power a completed charge asked for, and log it, as the spec requires.
    if (state.fired) {
      const sample = {
        action,
        hold: state.heldTime,
        charge: state.charge,
        speed: speedFor(state.charge, tuningFor(world, action)),
      };
      debug.recent.push(sample);
      if (debug.recent.length > 5) debug.recent.shift();
      console.log(
        `[charge] ${action} hold=${sample.hold.toFixed(2)}s charge=${sample.charge.toFixed(2)} power=${sample.speed.toFixed(1)} m/s`,
      );
    }
  }
}

const tuningFor = (world: SimWorld, action: (typeof CHARGED_ACTIONS)[number]) =>
  action === 'shoot'
    ? world.tuning.shot
    : action === 'cross'
      ? world.tuning.pass.lob
      : action === 'through'
        ? world.tuning.pass.through
        : world.tuning.pass.ground;

/** Keeps a rolling window of the match so a goal can be shown back straight away. */
function recordReplay(world: SimWorld, dt: number, timer: { current: number }): void {
  const replay = runtime.replay;
  if (replay.playing) return;
  timer.current += dt;
  if (timer.current < 1 / REPLAY_FPS) return;
  timer.current = 0;
  const frame: ReplayFrame = {
    ball: { x: world.ball.pos.x, y: world.ball.pos.y, z: world.ball.pos.z },
    players: world.players
      .filter((p) => !p.sentOff)
      .map((p) => ({
        id: p.id,
        x: p.pos.x,
        z: p.pos.z,
        heading: p.heading,
        height: p.height,
        gait: p.gait,
      })),
  };
  replay.buffer.push(frame);
  if (replay.buffer.length > REPLAY_CAPACITY) replay.buffer.shift();
}

function startReplay(): void {
  const replay = runtime.replay;
  if (replay.buffer.length < REPLAY_FPS) return;
  // Rewind to a couple of seconds before the ball hit the net.
  replay.cursor = Math.max(0, replay.buffer.length - REPLAY_FPS * 3.5);
  replay.playing = true;
}

/**
 * Plays the stored frames back over the live scene in slow motion. The simulation keeps
 * running underneath (the players are celebrating), the renderer simply shows the goal again.
 */
function playReplay(world: SimWorld, dt: number): void {
  const replay = runtime.replay;
  if (!replay.playing) return;
  if (world.phase !== 'goal') {
    replay.playing = false;
    replay.buffer.length = 0;
    return;
  }
  replay.cursor += dt * REPLAY_FPS * replay.speed;
  const index = Math.floor(replay.cursor);
  if (index >= replay.buffer.length) {
    replay.playing = false;
    replay.buffer.length = 0;
    return;
  }
  const frame = replay.buffer[index];
  if (runtime.ball) {
    runtime.ball.setTranslation(frame.ball, true);
    runtime.ball.setLinvel({ x: 0, y: 0, z: 0 }, false);
  }
  world.ball.pos = { ...frame.ball };
  for (const snapshot of frame.players) {
    const rb = runtime.bodies.get(snapshot.id);
    if (rb) {
      rb.setNextKinematicTranslation({ x: snapshot.x, y: snapshot.height, z: snapshot.z });
      rb.setNextKinematicRotation({
        x: 0,
        y: Math.sin(snapshot.heading / 2),
        z: 0,
        w: Math.cos(snapshot.heading / 2),
      });
    }
    const rig = runtime.visuals.get(snapshot.id);
    if (rig) {
      const swing = Math.sin(snapshot.gait * 2) * 0.6;
      rig.legL.rotation.x = swing;
      rig.legR.rotation.x = -swing;
      rig.armL.rotation.x = -swing * 0.7;
      rig.armR.rotation.x = swing * 0.7;
      rig.root.position.y = snapshot.height;
    }
  }
}
