/**
 * Image helpers for uploads.
 *
 * Uploaded images are persisted in localStorage as data URLs, and that store is
 * capped at roughly 5 MB per origin in Chrome. A single photo straight off a
 * camera easily exceeds that on its own (a 4000x3000 PNG data URL is ~12 MB),
 * so the write throws and the upload silently fails to persist. Re-encoding to
 * a bounded WebP keeps textures well inside the budget — 2048px is already far
 * more resolution than a particle sprite or a colour-mapping source needs.
 */

/** Longest edge kept when re-encoding an upload. */
const MAX_EDGE = 2048;

/** Uploads below this stay untouched — no needless re-encode of small sprites. */
const PASSTHROUGH_BYTES = 256 * 1024;

const loadImage = (dataUrl: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image could not be decoded'));
    img.src = dataUrl;
  });

/**
 * Shrinks an image data URL so it fits comfortably in localStorage.
 *
 * Returns the original string unchanged when it is already small, or when the
 * image cannot be decoded — the caller stores what the user gave us rather than
 * dropping the upload.
 */
export const shrinkImageDataUrl = async (dataUrl: string): Promise<string> => {
  if (dataUrl.length <= PASSTHROUGH_BYTES) return dataUrl;

  try {
    const img = await loadImage(dataUrl);
    const { naturalWidth: w, naturalHeight: h } = img;
    if (!w || !h) return dataUrl;

    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));

    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // WebP keeps the alpha channel particle sprites rely on and is far smaller
    // than PNG for photographic sources.
    const encoded = canvas.toDataURL('image/webp', 0.92);
    if (!encoded.startsWith('data:image/webp')) return dataUrl;

    return encoded.length < dataUrl.length ? encoded : dataUrl;
  } catch {
    return dataUrl;
  }
};

/** Human-readable size of a data URL, for error messages. */
export const dataUrlSizeMB = (dataUrl: string): number =>
  +(dataUrl.length / 1024 / 1024).toFixed(1);
