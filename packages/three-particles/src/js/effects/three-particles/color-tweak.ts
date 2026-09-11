/**
 * The source's own look, applied to a sampled pixel before it becomes a
 * particle's start colour: hue, saturation and contrast, in display (sRGB)
 * space, the way an image editor applies them. Prepared once per system as a
 * 3x3 matrix and an offset, so a spawn costs nine multiplies.
 *
 * The matrices are the SVG feColorMatrix / CSS filter ones (hue-rotate and
 * saturate), which keep Rec.709 luma where they can.
 */
export type ColorTweakSettings = {
  /** 1 leaves the colour alone; 0 is grey; above 1 pushes it. */
  saturation?: number;
  /** "Level": 1 leaves the colour alone; 0 is flat mid-grey; above 1 spreads it about mid-grey. */
  contrast?: number;
  /** Hue rotation in degrees; 0 leaves the colour alone. */
  hue?: number;
};

export type ColorTweak = {
  /** Row-major 3x3, applied to (r, g, b). */
  m: Float64Array;
  /** Added to every channel after the matrix. */
  offset: number;
};

const LR = 0.2126;
const LG = 0.7152;
const LB = 0.0722;

/** Prepares the adjustment; null when it would change nothing. */
export const buildColorTweak = (
  settings?: ColorTweakSettings | null
): ColorTweak | null => {
  const s = settings?.saturation ?? 1;
  const k = settings?.contrast ?? 1;
  const hue = settings?.hue ?? 0;
  if (s === 1 && k === 1 && hue === 0) return null;

  const a = (hue * Math.PI) / 180;
  const c = Math.cos(a);
  const n = Math.sin(a);
  // Hue rotation about the grey axis (SVG feColorMatrix hueRotate).
  const h = [
    LR + (1 - LR) * c - LR * n,
    LG - LG * c - LG * n,
    LB - LB * c + (1 - LB) * n,
    LR - LR * c + 0.143 * n,
    LG + (1 - LG) * c + 0.14 * n,
    LB - LB * c - 0.283 * n,
    LR - LR * c - (1 - LR) * n,
    LG - LG * c + LG * n,
    LB + (1 - LB) * c + LB * n,
  ];
  // Saturation: a lerp between luma and the colour itself (SVG saturate).
  const sat = [
    LR + (1 - LR) * s,
    LG - LG * s,
    LB - LB * s,
    LR - LR * s,
    LG + (1 - LG) * s,
    LB - LB * s,
    LR - LR * s,
    LG - LG * s,
    LB + (1 - LB) * s,
  ];
  // sat · hue, then contrast scales the whole thing about mid-grey.
  const m = new Float64Array(9);
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      let sum = 0;
      for (let i = 0; i < 3; i += 1) sum += sat[row * 3 + i] * h[i * 3 + col];
      m[row * 3 + col] = sum * k;
    }
  }
  return { m, offset: 0.5 * (1 - k) };
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Applies a prepared tweak to an sRGB colour in 0..1, into `out`. */
export const applyColorTweak = (
  tweak: ColorTweak,
  r: number,
  g: number,
  b: number,
  out: [number, number, number]
): [number, number, number] => {
  const { m, offset } = tweak;
  out[0] = clamp01(m[0] * r + m[1] * g + m[2] * b + offset);
  out[1] = clamp01(m[3] * r + m[4] * g + m[5] * b + offset);
  out[2] = clamp01(m[6] * r + m[7] * g + m[8] * b + offset);
  return out;
};

/**
 * The luminosity noise map: the luminance that counts as black maps to 0,
 * the one that counts as white to 1, and everything is clamped between. A
 * white point at or below the black point leaves no range to stretch, so it
 * is a hard threshold at the black point.
 */
export const remapLuminance = (luma: number, black = 0, white = 1): number => {
  if (white <= black) return luma >= black ? 1 : 0;
  return clamp01((luma - black) / (white - black));
};
