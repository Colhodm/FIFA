import { useEffect, useRef } from 'react';
import { runtime } from '../game/runtime';

const fmt = (n: number, digits = 2) => n.toFixed(digits);

/**
 * The numeric half of the F1 overlay (§6). Driven from its own animation frame rather than
 * React state, so switching it on never changes the frame budget it is meant to measure.
 */
export function DebugPanel() {
  const el = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let frame = 0;
    // Sim rate is sampled over a window: 60 ticks/sec is real time, anything less is the match
    // running in slow motion because the frame budget could not keep up.
    let windowStart = performance.now();
    let ticksAt = runtime.diag.ticks;
    let framesAt = runtime.diag.frames;
    let tickRate = 60;
    let frameRate = 60;

    const draw = () => {
      frame = requestAnimationFrame(draw);
      const node = el.current;
      const world = runtime.world;
      if (!node || !world) return;
      const d = runtime.debug;
      const active = world.players.find((p) => p.id === world.activeId);

      const elapsed = (performance.now() - windowStart) / 1000;
      if (elapsed >= 0.5) {
        tickRate = (runtime.diag.ticks - ticksAt) / elapsed;
        frameRate = (runtime.diag.frames - framesAt) / elapsed;
        ticksAt = runtime.diag.ticks;
        framesAt = runtime.diag.frames;
        windowStart = performance.now();
      }

      node.textContent = [
        `context   ${d.context}${world.controllerId === world.activeId ? ' (on the ball)' : ''}`,
        `buffer    ${d.buffered ? `${d.buffered} +${fmt(d.bufferAge)}s` : '—'}`,
        '',
        `raw       x ${fmt(d.raw.x)}  z ${fmt(d.raw.z)}   |v| ${fmt(Math.hypot(d.raw.x, d.raw.z))}`,
        `world     x ${fmt(d.world.x)}  z ${fmt(d.world.z)}   |v| ${fmt(Math.hypot(d.world.x, d.world.z))}`,
        `cameraYaw ${fmt(runtime.cameraYaw)} rad`,
        '',
        `control   #${active?.shirt ?? '—'} ${active?.name ?? '—'}`,
        'switch candidates (lower is better)',
        ...d.candidates.map(
          (c, i) =>
            `  ${i + 1}. ${c.name.padEnd(16)} ${fmt(c.score, 1).padStart(6)}` +
            `  pred ${fmt(c.predicted, 1)}m  now ${fmt(c.current, 1)}m  ang ${fmt(c.angle, 1)}`,
        ),
        '',
        `charge    ${d.chargeAction ?? '—'}  t_hold ${fmt(d.holdSeconds)}s  ${fmt(d.charge * 100, 0)}%`,
        'last 5 releases',
        ...(d.recent.length
          ? d.recent
              .slice()
              .reverse()
              .map(
                (s) =>
                  `  ${s.action.padEnd(8)} hold ${fmt(s.hold)}s  charge ${fmt(s.charge)}  ${fmt(s.speed, 1)} m/s`,
              )
          : ['  —']),
        '',
        `sim       ${fmt(tickRate, 1)} ticks/s (60 = real time)  ${fmt(frameRate, 0)} fps`,
        `          x${fmt(tickRate / 60, 2)} match speed  starved ${runtime.diag.starvedFrames}`,
      ].join('\n');
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <pre ref={el} className="debug-panel" />;
}
