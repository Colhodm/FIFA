import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { audio } from '../audio/audio';
import { CHARGE_TIME, HALF_LENGTH, MAX_TICKS_PER_FRAME, TICK_DT } from '../constants';
import { FrameSampler } from '../perf/quality';
import { runtime } from '../runtime';
import { clamp } from '../sim/math';
import { matchMinute } from '../sim/rules';
import type { SimWorld } from '../sim/state';
import { tick } from '../sim/step';
import { useGameStore, useHudStore } from '../store';

const HUD_INTERVAL = 0.1;

/** Drives the fixed-timestep simulation, mirrors it onto the physics bodies and the HUD. */
export function Simulation({ world }: { world: SimWorld }) {
  const accumulator = useRef(0);
  const hudTimer = useRef(0);
  const clock = useRef(0);
  const sampler = useMemo(() => new FrameSampler(), []);

  useFrame((_state, delta) => {
    const dt = Math.min(delta, 0.25);
    clock.current += dt;

    const qualityStep = sampler.sample(dt);
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
      tick(world, frame, runtime.cameraYaw, TICK_DT);
      if (frame.actions.pause.pressed) useGameStore.getState().setPaused(true);
      runtime.charge =
        frame.actions.shoot.down || frame.actions.pass.down
          ? clamp(
              Math.max(frame.actions.shoot.heldTime, frame.actions.pass.heldTime) / CHARGE_TIME,
              0,
              1,
            )
          : 0;
    }
    if (accumulator.current > TICK_DT * MAX_TICKS_PER_FRAME) accumulator.current = 0;

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
    }
    world.commands.length = 0;

    for (const player of world.players) {
      const rb = runtime.bodies.get(player.id);
      if (rb) {
        rb.setNextKinematicTranslation({ x: player.pos.x, y: 0, z: player.pos.z });
        rb.setNextKinematicRotation({
          x: 0,
          y: Math.sin(player.heading / 2),
          z: 0,
          w: Math.cos(player.heading / 2),
        });
      }
      const visual = runtime.visuals.get(player.id);
      if (visual) {
        const speed = Math.hypot(player.vel.x, player.vel.z);
        const stride = Math.min(1, speed / 7);
        visual.position.y = Math.abs(Math.sin(clock.current * (4 + speed))) * 0.06 * stride;
        visual.rotation.x = -stride * 0.14;
      }
    }

    if (runtime.indicator) {
      const active = world.players.find((p) => p.id === world.activeId);
      runtime.indicator.visible = Boolean(active);
      if (active) runtime.indicator.position.set(active.pos.x, 0.03, active.pos.z);
    }

    for (const event of world.events) {
      switch (event.type) {
        case 'kick':
        case 'pass':
        case 'shot':
          audio.kick(event.intensity ?? 0.6);
          break;
        case 'save':
          audio.save();
          break;
        case 'tackle':
          audio.tackle();
          break;
        case 'goal':
          audio.goal();
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

    hudTimer.current += dt;
    if (hudTimer.current < HUD_INTERVAL) return;
    hudTimer.current = 0;

    const goalDistance = Math.min(
      Math.hypot(HALF_LENGTH - world.ball.pos.x, world.ball.pos.z),
      Math.hypot(-HALF_LENGTH - world.ball.pos.x, world.ball.pos.z),
    );
    audio.setCrowdIntensity(world.phase === 'goal' ? 1 : clamp(1 - goalDistance / 48, 0.05, 0.95));

    const active = world.players.find((p) => p.id === world.activeId);
    const total = world.possessionTicks.home + world.possessionTicks.away || 1;
    useHudStore.getState().set({
      phase: world.phase,
      half: world.half,
      minute: matchMinute(world),
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
      fps: Math.round(sampler.fps),
      tierName: useGameStore.getState().tier.name,
      charge: runtime.charge,
    });
  });

  return null;
}
