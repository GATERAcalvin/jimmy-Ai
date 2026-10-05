// Ruth's face: a stylised portrait drawn entirely in code (no images), in the
// spirit of the reference picture: dark skin, a black durag, silver rectangular
// glasses, heavy brows, a gold stud and a grey hoodie.
//
// Everything is in units of R (the head is about 1.8 R wide), origin at the
// middle of the head, y pointing down. The engine owns the animation (blink, head
// turn, expressions, state colour); this file only draws one frame of it.

import type { EyeShape, RGB } from "./engine";

// ── Palette (sampled from the reference picture, lightly brightened for small sizes) ──

const SKIN_LIGHT = "#A96F4E";
const SKIN = "#98634A";
const SKIN_SHADE = "#6E4330";
const SKIN_DEEP = "#4A2B1E";
const EAR = "#7A4C36";
const BROW = "#24120B";
const LASH = "#1B0E09";
const EYE_WHITE = "#EDE8E2";
const IRIS = "#4B2C20";
const PUPIL = "#140B08";
const DURAG_TOP = "#35333C";
const DURAG_BOTTOM = "#15141A";
const FRAME = "#DADEE3";
const GOLD = "#E2B766";
const TEE = "#D6D5D8";

/** Hoodie grey the state colour is mixed into. */
export const HOODIE_BASE: RGB = [0.34, 0.335, 0.365];

// ── Public types ──────────────────────────────────────────────────────────────

export interface Brow {
  /** Up (negative) or down (positive), in R. */
  raise: number;
  /** Slope: positive drops the inner end (a serious look), negative lifts it (soft, sad). */
  slope: number;
}

export interface PortraitPose {
  /** Head turn as the engine computes it (radians, about ±0.6). */
  yaw: number;
  pitch: number;
  /** Blink: 1 open … 0 closed. */
  open: number;
  /** Eye scale (grows slightly when the pointer rests on Ruth). */
  es: number;
  shape: EyeShape;
  /** Left and right brow (viewer's left first). */
  brows: [Brow, Brow];
  hoodie: RGB;
  /** Mouth opening while Ruth speaks, 0…1. */
  talk: number;
  /** Warm flush on the cheeks, 0…1. */
  blush: number;
  /** 0…1 — lets the engine cross-fade to the mailbox. */
  alpha: number;
  /** The engine's own drawing of the non-open eye shapes (arcs, hearts, spirals…). */
  eyeShape: (x: CanvasRenderingContext2D, shape: EyeShape, w: number, h: number, sd: number) => void;
}

// ── Expression tables (used by the engine and the preview) ────────────────────

/** Where the brows go for an eye shape. sd = −1 for the viewer's left eye. */
export function browFor(shape: EyeShape, sd: number): Brow {
  switch (shape) {
    case "wide": return { raise: -0.07, slope: 0.1 };
    case "dot": return { raise: -0.11, slope: -0.14 };
    case "line": return { raise: 0.03, slope: 0.55 };
    case "flat": return { raise: 0.02, slope: 0.4 };
    case "happy": return { raise: -0.05, slope: -0.08 };
    case "closed": return { raise: 0.0, slope: -0.05 };
    case "tired": return { raise: 0.02, slope: -0.32 };
    case "wink": return sd < 0 ? { raise: 0, slope: 0.2 } : { raise: -0.09, slope: -0.1 };
    case "heart":
    case "star": return { raise: -0.08, slope: -0.12 };
    case "spiral": return { raise: -0.04, slope: 0 };
    default: return { raise: 0, slope: 0.3 }; // pill, cup: serious
  }
}

type Mood = "neutral" | "smile" | "frown" | "o" | "sleep" | "wavy";

function moodFor(shape: EyeShape): Mood {
  switch (shape) {
    case "happy":
    case "heart":
    case "star":
    case "wink": return "smile";
    case "flat":
    case "line": return "frown";
    case "tired": return "frown";
    case "dot":
    case "wide": return "o";
    case "closed": return "sleep";
    case "spiral": return "wavy";
    default: return "neutral";
  }
}

/** Open eyes get the full almond with iris; the rest use the engine's marks. */
function isOpen(shape: EyeShape, sd: number): boolean {
  return shape === "pill" || shape === "wide" || shape === "dot" || shape === "cup" || (shape === "wink" && sd < 0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const rgb = (c: RGB, a = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
];

function rrect(x: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, r: number) {
  const k = Math.max(0, Math.min(r, W / 2, H / 2));
  x.beginPath();
  x.moveTo(X + k, Y);
  x.arcTo(X + W, Y, X + W, Y + H, k);
  x.arcTo(X + W, Y + H, X, Y + H, k);
  x.arcTo(X, Y + H, X, Y, k);
  x.arcTo(X, Y, X + W, Y, k);
  x.closePath();
}

// ── The frame ─────────────────────────────────────────────────────────────────

export function drawPortrait(x: CanvasRenderingContext2D, R: number, p: PortraitPose): void {
  if (p.alpha <= 0.005) return;

  // Features slide with the head turn; the silhouette stays put.
  const dx = Math.sin(p.yaw) * 0.3 * R;
  const dy = -Math.sin(p.pitch) * 0.2 * R;
  // Never thinner than a hairline, or the glasses vanish on a small island.
  const lw = (v: number) => Math.max(v * R, 0.8);

  x.save();
  x.globalAlpha *= p.alpha;

  drawHoodie(x, R, p.hoodie);
  drawTail(x, R, dx);
  drawNeck(x, R);
  drawEars(x, R);

  // Head.
  x.save();
  headPath(x, R);
  const skin = x.createLinearGradient(-0.7 * R, -0.9 * R, 0.8 * R, 1.0 * R);
  skin.addColorStop(0, SKIN_LIGHT);
  skin.addColorStop(0.55, SKIN);
  skin.addColorStop(1, SKIN_SHADE);
  x.fillStyle = skin;
  x.fill();
  x.clip();

  // Jaw shadow and a soft light on the cheekbones.
  const jaw = x.createLinearGradient(0, 0.2 * R, 0, 1.0 * R);
  jaw.addColorStop(0, "rgba(40,20,12,0)");
  jaw.addColorStop(1, "rgba(40,20,12,0.5)");
  x.fillStyle = jaw;
  x.fillRect(-R, 0.2 * R, 2 * R, 0.9 * R);
  x.fillStyle = "rgba(255,200,160,0.12)";
  for (const sd of [-1, 1]) {
    x.beginPath();
    x.ellipse(sd * 0.52 * R + dx * 0.8, 0.3 * R + dy * 0.8, 0.24 * R, 0.15 * R, 0, 0, Math.PI * 2);
    x.fill();
  }
  if (p.blush > 0.01) {
    x.fillStyle = `rgba(255,110,80,${0.3 * p.blush})`;
    for (const sd of [-1, 1]) {
      x.beginPath();
      x.ellipse(sd * 0.52 * R + dx, 0.34 * R + dy, 0.24 * R, 0.14 * R, 0, 0, Math.PI * 2);
      x.fill();
    }
  }

  // Everything on the face moves together.
  x.translate(dx, dy);
  drawNose(x, R);
  drawMouth(x, R, p, lw);
  drawEyes(x, R, p, lw);
  drawBrows(x, R, p, lw);
  x.restore();

  drawGlasses(x, R, dx, dy, lw);
  drawDurag(x, R, dx, dy, lw);

  x.restore();
}

// ── Parts ─────────────────────────────────────────────────────────────────────

function headPath(x: CanvasRenderingContext2D, R: number) {
  x.beginPath();
  x.moveTo(-0.86 * R, -0.5 * R);
  x.bezierCurveTo(-0.92 * R, -0.05 * R, -0.86 * R, 0.38 * R, -0.58 * R, 0.72 * R);
  x.bezierCurveTo(-0.4 * R, 0.95 * R, -0.16 * R, 1.0 * R, 0, 1.0 * R);
  x.bezierCurveTo(0.16 * R, 1.0 * R, 0.4 * R, 0.95 * R, 0.58 * R, 0.72 * R);
  x.bezierCurveTo(0.86 * R, 0.38 * R, 0.92 * R, -0.05 * R, 0.86 * R, -0.5 * R);
  x.bezierCurveTo(0.7 * R, -1.1 * R, -0.7 * R, -1.1 * R, -0.86 * R, -0.5 * R);
  x.closePath();
}

/** The hoodie: a rounded bust, the hood bunched round the neck, a white tee at the collar. */
function drawHoodie(x: CanvasRenderingContext2D, R: number, c: RGB) {
  const top = mix(c, [1, 1, 1], 0.12);
  const bottom = mix(c, [0, 0, 0], 0.3);

  // Bust.
  x.beginPath();
  x.moveTo(-0.5 * R, 0.86 * R);
  x.bezierCurveTo(-1.1 * R, 0.9 * R, -1.62 * R, 1.0 * R, -1.62 * R, 1.55 * R);
  x.bezierCurveTo(-1.62 * R, 1.78 * R, -1.45 * R, 1.8 * R, -1.2 * R, 1.8 * R);
  x.lineTo(1.2 * R, 1.8 * R);
  x.bezierCurveTo(1.45 * R, 1.8 * R, 1.62 * R, 1.78 * R, 1.62 * R, 1.55 * R);
  x.bezierCurveTo(1.62 * R, 1.0 * R, 1.1 * R, 0.9 * R, 0.5 * R, 0.86 * R);
  x.closePath();
  const g = x.createLinearGradient(0, 0.8 * R, 0, 1.8 * R);
  g.addColorStop(0, rgb(top));
  g.addColorStop(1, rgb(bottom));
  x.fillStyle = g;
  x.fill();

  // Hood bunched either side of the neck.
  x.fillStyle = rgb(mix(c, [1, 1, 1], 0.2));
  for (const sd of [-1, 1]) {
    x.beginPath();
    x.ellipse(sd * 0.85 * R, 1.02 * R, 0.52 * R, 0.34 * R, sd * 0.25, 0, Math.PI * 2);
    x.fill();
  }

  // Dark inside of the hood, then the tee.
  x.beginPath();
  x.moveTo(-0.66 * R, 0.84 * R);
  x.bezierCurveTo(-0.5 * R, 1.5 * R, 0.5 * R, 1.5 * R, 0.66 * R, 0.84 * R);
  x.closePath();
  x.fillStyle = rgb(mix(c, [0, 0, 0], 0.7));
  x.fill();
  x.beginPath();
  x.moveTo(-0.36 * R, 0.95 * R);
  x.lineTo(0.36 * R, 0.95 * R);
  x.lineTo(0, 1.34 * R);
  x.closePath();
  x.fillStyle = TEE;
  x.fill();

  // Drawstrings.
  x.strokeStyle = "rgba(230,230,235,0.85)";
  x.lineWidth = Math.max(0.045 * R, 0.7);
  x.lineCap = "round";
  for (const sd of [-1, 1]) {
    x.beginPath();
    x.moveTo(sd * 0.3 * R, 1.22 * R);
    x.quadraticCurveTo(sd * 0.36 * R, 1.45 * R, sd * 0.33 * R, 1.68 * R);
    x.stroke();
  }
}

/** The durag's tail, hanging behind the neck on the viewer's left. */
function drawTail(x: CanvasRenderingContext2D, R: number, dx: number) {
  x.beginPath();
  x.moveTo(-0.78 * R + dx * 0.3, 0.2 * R);
  x.quadraticCurveTo(-0.95 * R, 0.8 * R, -0.62 * R, 1.34 * R);
  x.quadraticCurveTo(-0.5 * R, 1.2 * R, -0.5 * R, 0.8 * R);
  x.closePath();
  x.fillStyle = DURAG_BOTTOM;
  x.fill();
}

function drawNeck(x: CanvasRenderingContext2D, R: number) {
  x.beginPath();
  x.moveTo(-0.4 * R, 0.6 * R);
  x.lineTo(-0.42 * R, 1.12 * R);
  x.quadraticCurveTo(0, 1.26 * R, 0.42 * R, 1.12 * R);
  x.lineTo(0.4 * R, 0.6 * R);
  x.closePath();
  x.fillStyle = SKIN_DEEP;
  x.fill();
}

/** Human ears at the sides, with a gold stud in the viewer's right one. */
function drawEars(x: CanvasRenderingContext2D, R: number) {
  for (const sd of [-1, 1]) {
    x.beginPath();
    x.ellipse(sd * 0.9 * R, 0.0, 0.16 * R, 0.27 * R, sd * 0.12, 0, Math.PI * 2);
    x.fillStyle = EAR;
    x.fill();
    x.beginPath();
    x.ellipse(sd * 0.92 * R, 0.0, 0.07 * R, 0.14 * R, sd * 0.12, 0, Math.PI * 2);
    x.fillStyle = "rgba(60,30,20,0.55)";
    x.fill();
  }
  x.beginPath();
  x.arc(0.9 * R, 0.27 * R, Math.max(0.075 * R, 0.9), 0, Math.PI * 2);
  x.fillStyle = GOLD;
  x.fill();
  x.beginPath();
  x.arc(0.88 * R, 0.25 * R, Math.max(0.025 * R, 0.35), 0, Math.PI * 2);
  x.fillStyle = "rgba(255,255,255,0.8)";
  x.fill();
}

function drawNose(x: CanvasRenderingContext2D, R: number) {
  // Light down the bridge.
  x.beginPath();
  x.ellipse(0.02 * R, 0.1 * R, 0.05 * R, 0.14 * R, 0, 0, Math.PI * 2);
  x.fillStyle = "rgba(255,205,165,0.13)";
  x.fill();
  // Tip and nostrils.
  x.beginPath();
  x.ellipse(0, 0.3 * R, 0.17 * R, 0.1 * R, 0, 0, Math.PI * 2);
  x.fillStyle = "rgba(70,36,22,0.5)";
  x.fill();
  x.fillStyle = "rgba(30,14,9,0.75)";
  for (const sd of [-1, 1]) {
    x.beginPath();
    x.ellipse(sd * 0.075 * R, 0.335 * R, 0.035 * R, 0.022 * R, 0, 0, Math.PI * 2);
    x.fill();
  }
}

function drawMouth(
  x: CanvasRenderingContext2D, R: number, p: PortraitPose, lw: (v: number) => number,
) {
  const y = 0.6 * R;
  x.lineCap = "round";
  x.strokeStyle = "#2A130C";

  // Speaking overrides every mood: lips parted, dark inside.
  if (p.talk > 0.03) {
    const h = (0.03 + 0.13 * p.talk) * R;
    x.beginPath();
    x.ellipse(0, y + h * 0.35, 0.17 * R, h, 0, 0, Math.PI * 2);
    x.fillStyle = "#1E0B07";
    x.fill();
    x.lineWidth = lw(0.035);
    x.strokeStyle = "rgba(60,26,16,0.9)";
    x.stroke();
    return;
  }

  switch (moodFor(p.shape)) {
    case "smile":
      x.lineWidth = lw(0.055);
      x.beginPath();
      x.moveTo(-0.2 * R, y - 0.02 * R);
      x.quadraticCurveTo(0, y + 0.17 * R, 0.2 * R, y - 0.02 * R);
      x.stroke();
      break;
    case "frown":
      x.lineWidth = lw(0.055);
      x.beginPath();
      x.moveTo(-0.18 * R, y + 0.07 * R);
      x.quadraticCurveTo(0, y - 0.07 * R, 0.18 * R, y + 0.07 * R);
      x.stroke();
      break;
    case "o":
      x.beginPath();
      x.ellipse(0, y + 0.04 * R, 0.085 * R, 0.1 * R, 0, 0, Math.PI * 2);
      x.fillStyle = "#1E0B07";
      x.fill();
      break;
    case "sleep":
      x.lineWidth = lw(0.05);
      x.beginPath();
      x.moveTo(-0.12 * R, y);
      x.lineTo(0.12 * R, y);
      x.stroke();
      break;
    case "wavy":
      x.lineWidth = lw(0.05);
      x.beginPath();
      x.moveTo(-0.2 * R, y);
      x.bezierCurveTo(-0.1 * R, y - 0.06 * R, -0.05 * R, y + 0.06 * R, 0.02 * R, y);
      x.bezierCurveTo(0.08 * R, y - 0.06 * R, 0.14 * R, y + 0.06 * R, 0.2 * R, y);
      x.stroke();
      break;
    default:
      // A flat, slightly downturned line with a heavier lower lip.
      x.lineWidth = lw(0.055);
      x.beginPath();
      x.moveTo(-0.18 * R, y + 0.015 * R);
      x.quadraticCurveTo(0, y - 0.025 * R, 0.18 * R, y + 0.015 * R);
      x.stroke();
      x.beginPath();
      x.ellipse(0, y + 0.1 * R, 0.13 * R, 0.04 * R, 0, 0, Math.PI * 2);
      x.fillStyle = "rgba(45,20,12,0.5)";
      x.fill();
  }
}

function drawEyes(
  x: CanvasRenderingContext2D, R: number, p: PortraitPose, lw: (v: number) => number,
) {
  for (const sd of [-1, 1]) {
    x.save();
    x.translate(sd * 0.44 * R, -0.04 * R);

    if (!isOpen(p.shape, sd)) {
      x.fillStyle = LASH;
      x.strokeStyle = LASH;
      p.eyeShape(x, p.shape, 0.2 * R * p.es, 0.22 * R * p.es, sd);
    } else {
      const wide = p.shape === "wide";
      const dot = p.shape === "dot";
      const ew = (dot ? 0.2 : wide ? 0.25 : 0.23) * R * p.es;
      const eh = (dot ? 0.14 : wide ? 0.115 : 0.085) * R * p.es * Math.max(p.open, 0.06);
      const lid = dot || wide ? 0 : 0.3;
      // Where the eyes point: a little of the head turn goes into the iris as well.
      const ix = clamp(p.yaw * 0.9, -1, 1) * ew * 0.32;
      const iy = clamp(-p.pitch * 0.9, -1, 1) * Math.max(eh, 0.04 * R) * 0.35;
      almondEye(x, R, sd, ew, eh, lid, ix, iy, dot ? 0.38 : 0.5, lw);
    }
    x.restore();
  }
}

/** One open eye. Local +x points to the outside corner (mirrored for the left eye). */
function almondEye(
  x: CanvasRenderingContext2D, R: number, sd: number,
  ew: number, eh: number, lid: number, ix: number, iy: number, irisK: number,
  lw: (v: number) => number,
) {
  x.save();
  x.scale(sd < 0 ? -1 : 1, 1);
  x.rotate(-0.1); // outer corner a touch higher: the unamused slant
  const lx = ix * (sd < 0 ? -1 : 1);

  const opening = () => {
    x.beginPath();
    x.moveTo(-ew, 0.01 * R);
    x.quadraticCurveTo(0, -eh * 2.2, ew, -0.005 * R);
    x.quadraticCurveTo(0, eh * 1.9, -ew, 0.01 * R);
    x.closePath();
  };

  opening();
  x.fillStyle = EYE_WHITE;
  x.fill();
  x.save();
  opening();
  x.clip();
  const ir = Math.max(ew * irisK, 0.9);
  x.beginPath();
  x.arc(lx, iy, ir, 0, Math.PI * 2);
  x.fillStyle = IRIS;
  x.fill();
  x.beginPath();
  x.arc(lx, iy, ir * 0.52, 0, Math.PI * 2);
  x.fillStyle = PUPIL;
  x.fill();
  if (ir > 1.6) {
    x.beginPath();
    x.arc(lx - ir * 0.32, iy - ir * 0.32, ir * 0.2, 0, Math.PI * 2);
    x.fillStyle = "rgba(255,255,255,0.85)";
    x.fill();
  }
  if (lid > 0) {
    // Heavy upper lid.
    x.fillStyle = SKIN_SHADE;
    x.fillRect(-ew * 1.2, -eh * 2.4, ew * 2.4, eh * (2.4 * lid * 2 - 0.1));
  }
  x.restore();

  // Lash line with a small wing at the outer corner.
  x.strokeStyle = LASH;
  x.lineCap = "round";
  x.lineWidth = lw(0.07);
  x.beginPath();
  x.moveTo(-ew * 1.02, 0.012 * R);
  x.quadraticCurveTo(0, -eh * 2.2, ew, -0.005 * R);
  x.lineTo(ew * 1.28, -0.045 * R);
  x.stroke();
  x.restore();
}

function drawBrows(
  x: CanvasRenderingContext2D, R: number, p: PortraitPose, lw: (v: number) => number,
) {
  x.strokeStyle = BROW;
  x.lineCap = "round";
  x.lineJoin = "round";
  for (const sd of [-1, 1]) {
    const b = p.brows[sd < 0 ? 0 : 1];
    const baseY = -0.4 * R + b.raise * R;
    const inner = { x: sd * 0.08 * R, y: baseY + b.slope * 0.3 * R };
    const outer = { x: sd * 0.76 * R, y: baseY - b.slope * 0.3 * R };
    x.lineWidth = lw(0.11);
    x.beginPath();
    x.moveTo(inner.x, inner.y);
    x.quadraticCurveTo((inner.x + outer.x) / 2, Math.min(inner.y, outer.y) - 0.045 * R, outer.x, outer.y);
    x.stroke();
  }
}

function drawGlasses(
  x: CanvasRenderingContext2D, R: number, dx: number, dy: number, lw: (v: number) => number,
) {
  x.save();
  x.translate(dx, dy);
  const cy = -0.04 * R;
  const hw = 0.385 * R;
  const hh = 0.255 * R;

  // Light catching the lenses.
  for (const sd of [-1, 1]) {
    const cx = sd * 0.44 * R;
    x.save();
    rrect(x, cx - hw, cy - hh, hw * 2, hh * 2, 0.07 * R);
    x.fillStyle = "rgba(225,238,255,0.1)";
    x.fill();
    x.clip();
    x.strokeStyle = "rgba(255,255,255,0.32)";
    x.lineWidth = lw(0.04);
    x.lineCap = "round";
    x.beginPath();
    x.moveTo(cx - hw * 0.15, cy + hh);
    x.lineTo(cx + hw * 0.45, cy - hh);
    x.moveTo(cx - hw * 0.55, cy + hh);
    x.lineTo(cx - hw * 0.1, cy - hh);
    x.stroke();
    x.restore();
  }

  // Frames: silver, with a heavier brow bar.
  x.strokeStyle = FRAME;
  x.lineJoin = "round";
  x.lineCap = "round";
  x.lineWidth = lw(0.055);
  for (const sd of [-1, 1]) {
    rrect(x, sd * 0.44 * R - hw, cy - hh, hw * 2, hh * 2, 0.07 * R);
    x.stroke();
    x.lineWidth = lw(0.085);
    x.beginPath();
    x.moveTo(sd * 0.44 * R - hw, cy - hh);
    x.lineTo(sd * 0.44 * R + hw, cy - hh);
    x.stroke();
    x.lineWidth = lw(0.055);
  }
  x.beginPath();
  x.moveTo(-0.055 * R, cy - 0.1 * R);
  x.lineTo(0.055 * R, cy - 0.1 * R);
  x.stroke();
  // Arms running back to the ears.
  for (const sd of [-1, 1]) {
    x.beginPath();
    x.moveTo(sd * (0.44 * R + hw), cy - 0.1 * R);
    x.lineTo(sd * 0.9 * R, cy - 0.06 * R);
    x.stroke();
  }
  x.restore();
}

function drawDurag(
  x: CanvasRenderingContext2D, R: number, dx: number, dy: number, lw: (v: number) => number,
) {
  x.save();
  x.translate(dx * 0.45, dy * 0.3);

  x.beginPath();
  x.moveTo(-0.95 * R, -0.26 * R);
  x.bezierCurveTo(-1.1 * R, -0.85 * R, -0.62 * R, -1.38 * R, 0, -1.38 * R);
  x.bezierCurveTo(0.62 * R, -1.38 * R, 1.1 * R, -0.85 * R, 0.95 * R, -0.26 * R);
  x.bezierCurveTo(0.7 * R, -0.5 * R, 0.36 * R, -0.62 * R, 0, -0.62 * R);
  x.bezierCurveTo(-0.36 * R, -0.62 * R, -0.7 * R, -0.5 * R, -0.95 * R, -0.26 * R);
  x.closePath();
  const g = x.createLinearGradient(0, -1.38 * R, 0, -0.3 * R);
  g.addColorStop(0, DURAG_TOP);
  g.addColorStop(1, DURAG_BOTTOM);
  x.fillStyle = g;
  x.fill();

  // Waves in the cloth, fanning out from the band.
  x.save();
  x.clip();
  x.strokeStyle = "rgba(255,255,255,0.11)";
  x.lineWidth = lw(0.035);
  x.lineCap = "round";
  const folds: [number, number, number, number, number][] = [
    [-0.6, -0.52, -0.62, -1.0, -0.2],
    [-0.25, -0.6, -0.3, -1.1, 0.05],
    [0.12, -0.62, 0.06, -1.14, 0.3],
    [0.5, -0.52, 0.5, -0.98, 0.55],
  ];
  for (const [x0, y0, cx, cy, x1] of folds) {
    x.beginPath();
    x.moveTo(x0 * R, y0 * R);
    x.quadraticCurveTo(cx * R, cy * R, x1 * R, -1.3 * R);
    x.stroke();
  }
  x.restore();

  // The band across the forehead.
  x.beginPath();
  x.moveTo(-0.95 * R, -0.26 * R);
  x.bezierCurveTo(-0.7 * R, -0.5 * R, -0.36 * R, -0.62 * R, 0, -0.62 * R);
  x.bezierCurveTo(0.36 * R, -0.62 * R, 0.7 * R, -0.5 * R, 0.95 * R, -0.26 * R);
  x.strokeStyle = "#0C0B0F";
  x.lineWidth = lw(0.08);
  x.stroke();
  x.strokeStyle = "rgba(255,255,255,0.18)";
  x.lineWidth = lw(0.025);
  x.stroke();
  x.restore();
}
