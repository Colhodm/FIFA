import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';
import {
  CENTER_CIRCLE_RADIUS,
  CORNER_ARC_RADIUS,
  GOAL_BOX_DEPTH,
  GOAL_BOX_WIDTH,
  HALF_LENGTH,
  HALF_WIDTH,
  PENALTY_BOX_DEPTH,
  PENALTY_BOX_WIDTH,
  PENALTY_SPOT_DISTANCE,
} from '../constants';

/** The textured plane is the pitch plus a run-off surround. */
export const SURFACE_LENGTH = 125;
export const SURFACE_WIDTH = 85;

const LINE_WIDTH_M = 0.16;

/**
 * Draws the full set of markings into a canvas instead of building line geometry:
 * one draw call for the whole pitch and crisp lines at any camera distance.
 */
export function createPitchTexture(resolution = 2048): CanvasTexture {
  const width = resolution;
  const height = Math.round((resolution * SURFACE_WIDTH) / SURFACE_LENGTH);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');

  const px = width / SURFACE_LENGTH;
  const toX = (x: number) => (x + SURFACE_LENGTH / 2) * px;
  const toZ = (z: number) => (z + SURFACE_WIDTH / 2) * px;

  // Darker, cooler surround so the playing surface pops the way it does on television.
  ctx.fillStyle = '#17471f';
  ctx.fillRect(0, 0, width, height);

  // Mown stripes across the length of the pitch. Each one is a gradient rather than a flat
  // band, because a roller leaves the grass leaning away from you and it catches the light.
  const stripes = 14;
  const stripeWidth = (HALF_LENGTH * 2) / stripes;
  for (let i = 0; i < stripes; i++) {
    const x0 = toX(-HALF_LENGTH + i * stripeWidth);
    const band = ctx.createLinearGradient(x0, 0, x0 + stripeWidth * px, 0);
    const light = i % 2 === 0;
    band.addColorStop(0, light ? '#34773a' : '#255a2b');
    band.addColorStop(0.5, light ? '#3c8942' : '#205024');
    band.addColorStop(1, light ? '#34773a' : '#255a2b');
    ctx.fillStyle = band;
    ctx.fillRect(x0, toZ(-HALF_WIDTH), stripeWidth * px + 1, HALF_WIDTH * 2 * px);
  }

  // Mower arcs at the ends of each run, the scuff you see behind the goals on TV.
  ctx.globalAlpha = 0.12;
  ctx.strokeStyle = '#0f3d18';
  ctx.lineWidth = 1.6 * px;
  for (const zEdge of [-HALF_WIDTH, HALF_WIDTH]) {
    for (let i = 1; i < stripes; i += 2) {
      ctx.beginPath();
      ctx.arc(toX(-HALF_LENGTH + i * stripeWidth), toZ(zEdge), stripeWidth * px, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // Worn-in goalmouths and centre circle, the giveaway that a pitch has been played on.
  for (const [wx, wz, r] of [
    [-HALF_LENGTH + 4, 0, 9],
    [HALF_LENGTH - 4, 0, 9],
    [0, 0, 5],
  ] as const) {
    const wear = ctx.createRadialGradient(toX(wx), toZ(wz), 0, toX(wx), toZ(wz), r * px);
    wear.addColorStop(0, 'rgba(150, 140, 90, 0.18)');
    wear.addColorStop(1, 'rgba(150, 140, 90, 0)');
    ctx.fillStyle = wear;
    ctx.fillRect(0, 0, width, height);
  }

  // Subtle wear noise so the grass is not perfectly flat colour.
  ctx.globalAlpha = 0.05;
  for (let i = 0; i < 12000; i++) {
    ctx.fillStyle = Math.random() > 0.5 ? '#ffffff' : '#000000';
    const r = Math.random() * 3 + 1;
    ctx.beginPath();
    ctx.arc(Math.random() * width, Math.random() * height, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Not pure white: paint on grass reads slightly grey, and it stops the lines blooming.
  ctx.strokeStyle = '#dfe6de';
  ctx.lineWidth = LINE_WIDTH_M * px;
  ctx.lineCap = 'butt';

  const rect = (x0: number, z0: number, x1: number, z1: number) =>
    ctx.strokeRect(toX(x0), toZ(z0), (x1 - x0) * px, (z1 - z0) * px);

  rect(-HALF_LENGTH, -HALF_WIDTH, HALF_LENGTH, HALF_WIDTH);

  ctx.beginPath();
  ctx.moveTo(toX(0), toZ(-HALF_WIDTH));
  ctx.lineTo(toX(0), toZ(HALF_WIDTH));
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(toX(0), toZ(0), CENTER_CIRCLE_RADIUS * px, 0, Math.PI * 2);
  ctx.stroke();

  const spot = (x: number, z: number) => {
    ctx.fillStyle = '#dfe6de';
    ctx.beginPath();
    ctx.arc(toX(x), toZ(z), 0.18 * px, 0, Math.PI * 2);
    ctx.fill();
  };
  spot(0, 0);

  for (const dir of [1, -1] as const) {
    const goalLine = HALF_LENGTH * dir;
    const boxEdge = (HALF_LENGTH - PENALTY_BOX_DEPTH) * dir;
    const sixEdge = (HALF_LENGTH - GOAL_BOX_DEPTH) * dir;
    rect(
      Math.min(goalLine, boxEdge),
      -PENALTY_BOX_WIDTH / 2,
      Math.max(goalLine, boxEdge),
      PENALTY_BOX_WIDTH / 2,
    );
    rect(
      Math.min(goalLine, sixEdge),
      -GOAL_BOX_WIDTH / 2,
      Math.max(goalLine, sixEdge),
      GOAL_BOX_WIDTH / 2,
    );

    const penaltySpotX = (HALF_LENGTH - PENALTY_SPOT_DISTANCE) * dir;
    spot(penaltySpotX, 0);

    // Penalty arc: only the segment outside the box.
    const arcHalfAngle = Math.acos(Math.abs(penaltySpotX - boxEdge) / CENTER_CIRCLE_RADIUS);
    const facing = dir > 0 ? Math.PI : 0;
    ctx.beginPath();
    ctx.arc(
      toX(penaltySpotX),
      toZ(0),
      CENTER_CIRCLE_RADIUS * px,
      facing - arcHalfAngle,
      facing + arcHalfAngle,
    );
    ctx.stroke();

    // Corner arcs: only the quarter that lies inside the pitch.
    for (const side of [1, -1] as const) {
      const start = dir > 0 ? (side > 0 ? Math.PI : Math.PI / 2) : side > 0 ? 1.5 * Math.PI : 0;
      ctx.beginPath();
      ctx.arc(
        toX(goalLine),
        toZ(HALF_WIDTH * side),
        CORNER_ARC_RADIUS * px,
        start,
        start + Math.PI / 2,
      );
      ctx.stroke();
    }
  }

  // Divot scars: short dark slashes, heaviest through the middle where the game is played.
  ctx.globalAlpha = 0.16;
  ctx.strokeStyle = '#123b17';
  ctx.lineWidth = 0.06 * px;
  for (let i = 0; i < 900; i++) {
    const x = toX((Math.random() - 0.5) * HALF_LENGTH * 2);
    const z = toZ((Math.random() - 0.5) * HALF_WIDTH * 1.9);
    const a = Math.random() * Math.PI;
    const len = (0.3 + Math.random() * 0.7) * px;
    ctx.beginPath();
    ctx.moveTo(x, z);
    ctx.lineTo(x + Math.cos(a) * len, z + Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 16;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  return texture;
}
