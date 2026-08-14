import { useEffect, useRef } from 'react';
import { HALF_LENGTH, HALF_WIDTH } from '../game/constants';
import { runtime } from '../game/runtime';
import type { Kit } from '../game/types';

const WIDTH = 210;
const HEIGHT = 136;
const PAD = 6;

/**
 * Broadcast radar: every player plotted on a miniature pitch, drawn straight from the live world
 * on its own animation frame so it never re-renders React.
 */
export function Radar({ homeKit, awayKit }: { homeKit?: Kit; awayKit?: Kit }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const home = homeKit?.primary ?? '#38bdf8';
  const away = awayKit?.primary ?? '#f87171';

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = WIDTH * dpr;
    el.height = HEIGHT * dpr;
    ctx.scale(dpr, dpr);

    let frame = 0;
    // The broadcast camera sits on the -z touchline looking towards +z, so on screen world +x
    // runs to the *left* and +z runs *up*. Both radar axes are flipped to match, otherwise a
    // player in the top-right of the picture shows up bottom-left on the map.
    const toX = (x: number) => PAD + ((HALF_LENGTH - x) / (HALF_LENGTH * 2)) * (WIDTH - PAD * 2);
    const toY = (z: number) => PAD + ((HALF_WIDTH - z) / (HALF_WIDTH * 2)) * (HEIGHT - PAD * 2);

    const draw = () => {
      frame = requestAnimationFrame(draw);
      const world = runtime.world;
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      ctx.fillStyle = 'rgba(6, 20, 12, 0.72)';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(PAD, PAD, WIDTH - PAD * 2, HEIGHT - PAD * 2);
      ctx.beginPath();
      ctx.moveTo(WIDTH / 2, PAD);
      ctx.lineTo(WIDTH / 2, HEIGHT - PAD);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(WIDTH / 2, HEIGHT / 2, 13, 0, Math.PI * 2);
      ctx.stroke();
      if (!world) return;

      for (const p of world.players) {
        ctx.beginPath();
        ctx.arc(toX(p.pos.x), toY(p.pos.z), p.id === world.activeId ? 3.6 : 2.6, 0, Math.PI * 2);
        ctx.fillStyle = p.side === 'home' ? home : away;
        ctx.fill();
        if (p.id === world.activeId) {
          ctx.strokeStyle = '#facc15';
          ctx.lineWidth = 1.6;
          ctx.stroke();
          ctx.lineWidth = 1;
        }
      }

      ctx.beginPath();
      ctx.arc(toX(world.ball.pos.x), toY(world.ball.pos.z), 2, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [home, away]);

  return <canvas ref={canvas} className="radar" style={{ width: WIDTH, height: HEIGHT }} />;
}
