import {
  CanvasTexture,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from 'three';
import { mulberry32 } from '../sim/math';
import type { Kit } from '../types';

/** Textures are pure functions of their arguments, so they are generated once and shared. */
const cache = new Map<string, CanvasTexture>();

function cached(key: string, make: () => CanvasTexture): CanvasTexture {
  const hit = cache.get(key);
  if (hit) return hit;
  const texture = make();
  cache.set(key, texture);
  return texture;
}

function canvas2d(width: number, height: number): CanvasRenderingContext2D {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  const ctx = element.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return ctx;
}

function colorTexture(ctx: CanvasRenderingContext2D): CanvasTexture {
  const texture = new CanvasTexture(ctx.canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/**
 * Tangent-space normals for the turf: fine blade noise plus the mower's roller marks, so
 * the grass catches the key light instead of reading as a flat green plane.
 */
export function grassNormalTexture(): CanvasTexture {
  return cached('grass-normal', () => {
    const size = 512;
    const ctx = canvas2d(size, size);
    const image = ctx.createImageData(size, size);
    const rand = mulberry32(20240607);
    // Height field first: short vertical blades with a little clumping.
    const height = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) height[i] = rand();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const blade = height[((y + size - 1) % size) * size + x] * 0.55;
        height[i] = height[i] * 0.45 + blade;
      }
    }
    const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * 2.2;
        const dy = (at(x, y + 1) - at(x, y - 1)) * 2.2;
        const len = Math.hypot(dx, dy, 1);
        const o = (y * size + x) * 4;
        image.data[o] = ((-dx / len) * 0.5 + 0.5) * 255;
        image.data[o + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
        image.data[o + 2] = (1 / len) * 255;
        image.data[o + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    const texture = new CanvasTexture(ctx.canvas);
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.anisotropy = 8;
    texture.minFilter = LinearMipmapLinearFilter;
    return texture;
  });
}

/**
 * A classic 32-panel ball: twelve black pentagons placed at the vertices of an icosahedron
 * and projected into the sphere's equirectangular UVs, with stitching between them.
 */
export function ballTexture(): CanvasTexture {
  return cached('ball', () => {
    const width = 1024;
    const height = 512;
    const ctx = canvas2d(width, height);
    ctx.fillStyle = '#f4f5f7';
    ctx.fillRect(0, 0, width, height);

    const phi = (1 + Math.sqrt(5)) / 2;
    const verts: [number, number, number][] = [];
    for (const s of [1, -1]) {
      for (const t of [1, -1]) {
        verts.push([0, s, t * phi], [s, t * phi, 0], [t * phi, 0, s]);
      }
    }
    const pentagon = (cx: number, cy: number, r: number, spin: number) => {
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = spin + (i / 5) * Math.PI * 2;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r * 0.92;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    };
    ctx.fillStyle = '#14161c';
    for (const [x, y, z] of verts) {
      const len = Math.hypot(x, y, z);
      const u = (Math.atan2(z / len, x / len) / (Math.PI * 2) + 0.5) * width;
      const v = (Math.acos(y / len) / Math.PI) * height;
      // Pinch the pentagon towards the poles, where the projection stretches horizontally.
      const pinch = Math.max(0.35, Math.sin((v / height) * Math.PI));
      const r = 44 / pinch;
      pentagon(u, v, Math.min(r, 130), (x + y) * 0.7);
      if (u < 140) pentagon(u + width, v, Math.min(r, 130), (x + y) * 0.7);
      if (u > width - 140) pentagon(u - width, v, Math.min(r, 130), (x + y) * 0.7);
    }

    // Faint hexagon stitching so the white panels are not a blank field.
    ctx.strokeStyle = 'rgba(120, 126, 140, 0.35)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 60; i++) {
      const u = ((i * 137.5) % 360) * (width / 360);
      const v = ((i * 61.7) % 170) * (height / 180) + 8;
      ctx.beginPath();
      ctx.arc(u, v, 26, 0, Math.PI * 2);
      ctx.stroke();
    }
    return colorTexture(ctx);
  });
}

/**
 * A wrapped shirt: sleeves in the change colour, a collar, the club's stripe pattern and the
 * squad number across the back. Cylindrical UVs put u=0 on the player's chest.
 */
export function shirtTexture(kit: Kit, shirt: number, keeper: boolean): CanvasTexture {
  return cached(`shirt-${kit.primary}-${kit.secondary}-${keeper}-${shirt}`, () => {
    const width = 512;
    const height = 256;
    const ctx = canvas2d(width, height);
    const base = keeper ? kit.keeper : kit.primary;
    const accent = keeper ? '#111827' : kit.secondary;
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, width, height);

    if (!keeper) {
      // Vertical stripes on the front and back panels only, so the sides stay clean.
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.85;
      for (let i = 0; i < 8; i++) {
        if (i % 2 === 1) continue;
        ctx.fillRect((i / 8) * width + width / 32, 0, width / 16, height);
      }
      ctx.globalAlpha = 1;
    }

    // Sleeves: the quarter turns either side of the body read as the arms' shoulder line.
    ctx.fillStyle = accent;
    ctx.fillRect(width * 0.2, 0, width * 0.1, height * 0.34);
    ctx.fillRect(width * 0.7, 0, width * 0.1, height * 0.34);

    // Collar.
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, width, height * 0.1);

    ctx.fillStyle = '#f8fafc';
    ctx.strokeStyle = 'rgba(15,23,42,0.55)';
    ctx.lineWidth = 5;
    ctx.font = `bold ${Math.round(height * 0.5)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = String(shirt);
    ctx.strokeText(label, width * 0.5, height * 0.55);
    ctx.fillText(label, width * 0.5, height * 0.55);
    return colorTexture(ctx);
  });
}

/** Rows of tip-up seats: the mosaic that makes empty stands look like a real stadium. */
export function seatTexture(primary: string, accent: string): CanvasTexture {
  return cached(`seats-${primary}-${accent}`, () => {
    const size = 256;
    const ctx = canvas2d(size, size);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, size, size);
    const cols = 16;
    const rows = 12;
    const w = size / cols;
    const h = size / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const band = Math.abs(r - rows / 2) < 2 && c % 5 !== 0;
        ctx.fillStyle = band ? accent : primary;
        ctx.fillRect(c * w + w * 0.12, r * h + h * 0.15, w * 0.76, h * 0.6);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(c * w + w * 0.12, r * h + h * 0.68, w * 0.76, h * 0.12);
      }
    }
    const texture = colorTexture(ctx);
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    return texture;
  });
}

/** Soft round blob used as a cheap contact shadow when real shadow maps are switched off. */
export function blobTexture(): CanvasTexture {
  return cached('blob', () => {
    const size = 128;
    const ctx = canvas2d(size, size);
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(0,0,0,0.55)');
    gradient.addColorStop(0.55, 'rgba(0,0,0,0.28)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return new CanvasTexture(ctx.canvas);
  });
}

/** Advertising hoarding artwork: fictional sponsors, drawn as bright LED panels. */
export function hoardingTexture(): CanvasTexture {
  return cached('hoarding', () => {
    const width = 2048;
    const height = 128;
    const ctx = canvas2d(width, height);
    /*
     * Perimeter LED reads as a dark band with bright lettering on television, not as a row of
     * saturated colour blocks. Eight fully-lit panels in primary colours were the loudest thing
     * on screen and made every wide shot look like a toy.
     */
    const sponsors = [
      // Title sponsor: this was built by Devin, so Cognition takes the naming rights and appears
      // more often around the ground than anybody else.
      ['#0a0f1a', '#7dd3fc', 'COGNITION'],
      ['#0a0f1a', '#7dd3fc', 'COGNITION  ·  DEVIN'],
      ['#101826', '#5eead4', 'NORTHWIND'],
      ['#0c1220', '#93c5fd', 'ORBIT BANK'],
      ['#1a1013', '#fca5a5', 'RED KETTLE'],
      ['#121020', '#c4b5fd', 'LUMEN'],
      ['#1a1410', '#fdba74', 'FORGE TYRES'],
      ['#0b1418', '#67e8f9', 'BLUE HARBOUR'],
      ['#0d1710', '#86efac', 'GREENLINE'],
      ['#140f1c', '#d8b4fe', 'AURORA AIR'],
      ['#0a0f1a', '#7dd3fc', 'COGNITION'],
    ] as const;
    const panel = width / sponsors.length;
    sponsors.forEach(([base, ink, name], i) => {
      ctx.fillStyle = base;
      ctx.fillRect(i * panel, 0, panel, height);
      // A thin lit strip along the bottom is what actually catches the eye on a broadcast.
      ctx.fillStyle = ink;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(i * panel, height * 0.86, panel, height * 0.14);
      ctx.globalAlpha = 1;
      ctx.fillStyle = ink;
      ctx.font = `bold ${Math.round(height * 0.36)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, i * panel + panel / 2, height * 0.44);
      // Panel seam.
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(i * panel, 0, 3, height);
    });
    const texture = colorTexture(ctx);
    texture.wrapS = RepeatWrapping;
    return texture;
  });
}

/** The title sponsor's name across the stand facade: COGNITION, in lights. */
export function facadeTexture(): CanvasTexture {
  return cached('facade', () => {
    const width = 2048;
    const height = 128;
    const ctx = canvas2d(width, height);
    ctx.fillStyle = '#0a0f1a';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#7dd3fc';
    ctx.font = `bold ${Math.round(height * 0.6)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = '14px';
    ctx.fillText('COGNITION', width * 0.5, height * 0.5);
    const texture = colorTexture(ctx);
    texture.wrapS = RepeatWrapping;
    return texture;
  });
}

export function disposeTextures(): void {
  for (const texture of cache.values()) (texture as Texture).dispose();
  cache.clear();
}
