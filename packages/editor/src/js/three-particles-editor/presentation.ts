/**
 * Presentation mode: this window becomes the display.
 *
 * The display window is the right shape on a desk — the editor keeps running
 * beside it. On a phone it is the wrong shape: window.open makes a tab, and
 * the tab that opened it is frozen the moment the new one is in front, so the
 * two can never run together. Presentation mode is the other way round the
 * same problem: instead of a second page, this page stops being an editor for
 * a while. Every panel is hidden, the viewport and the corner preview are not
 * drawn, and the output camera is rendered straight to the canvas, letterboxed
 * to its own aspect — the player's frame, in the editor's window. Where
 * element fullscreen exists the browser chrome goes too.
 *
 * Nothing is torn down. The panels are display:none, the editor camera and
 * its controls sit untouched, and leaving puts the canvas back to the window
 * and the buttons back on screen — so on a desk it doubles as a quick "show me
 * the piece" toggle.
 */
import { getOrbitControls, isPresenting, setPresenting } from './world';
import { selectSceneObject } from './scene-objects';

const BAR_HIDE_MS = 3000;

let bar: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
/** Whether *we* asked for fullscreen, so its ending is ours to react to. */
let requestedFullscreen = false;

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

const fullscreenActive = (): boolean =>
  !!(document.fullscreenElement ?? (document as FullscreenDocument).webkitFullscreenElement);

const requestFullscreen = (): void => {
  const root = document.documentElement as FullscreenElement;
  const request = root.requestFullscreen ?? root.webkitRequestFullscreen;
  if (!request) return;
  requestedFullscreen = true;
  Promise.resolve()
    .then(() => request.call(root))
    .catch(() => {
      // Refused (no gesture, or a browser that says no): the page-level
      // presentation is still on; only the chrome stays.
      requestedFullscreen = false;
    });
};

const leaveFullscreen = (): void => {
  requestedFullscreen = false;
  if (!fullscreenActive()) return;
  const doc = document as FullscreenDocument;
  void (document.exitFullscreen ?? doc.webkitExitFullscreen)?.call(document);
};

// ─── The exit bar ────────────────────────────────────────────────────────────
//
// A phone has no Escape key. A tap anywhere brings the bar up for a moment; it
// carries the way out and a toggle for the frame counter, which is the one
// instrument worth having on a wall while you are still measuring.

const ensureBar = (): HTMLElement => {
  if (bar) return bar;
  bar = document.createElement('div');
  bar.className = 'presentation-bar';

  const exit = document.createElement('button');
  exit.type = 'button';
  exit.className = 'presentation-bar__exit';
  exit.textContent = 'Exit';
  exit.addEventListener('click', (event) => {
    event.stopPropagation();
    exitPresentation();
  });

  const fps = document.createElement('button');
  fps.type = 'button';
  fps.className = 'presentation-bar__fps';
  fps.textContent = 'FPS';
  fps.addEventListener('click', (event) => {
    event.stopPropagation();
    const stats = document.querySelector<HTMLElement>('.stats');
    if (stats) stats.classList.toggle('is-hidden');
    showBar();
  });

  bar.append(exit, fps);
  document.body.appendChild(bar);
  return bar;
};

const showBar = (): void => {
  ensureBar().classList.add('is-visible');
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => bar?.classList.remove('is-visible'), BAR_HIDE_MS);
};

const hideBar = (): void => {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  bar?.classList.remove('is-visible');
};

// ─── Entering and leaving ────────────────────────────────────────────────────

export const enterPresentation = (): void => {
  if (isPresenting()) return;
  // Nothing selected: a gizmo drag would raycast through the editor camera
  // against a picture drawn by another one.
  selectSceneObject(null);
  getOrbitControls().enabled = false;
  document.body.classList.add('presenting');
  setPresenting(true);
  requestFullscreen();
  showBar();
};

export const exitPresentation = (): void => {
  if (!isPresenting()) return;
  document.body.classList.remove('presenting');
  setPresenting(false);
  getOrbitControls().enabled = true;
  hideBar();
  leaveFullscreen();
};

export const togglePresentation = (): void => {
  if (isPresenting()) exitPresentation();
  else enterPresentation();
};

/** Escape, the end of fullscreen, and taps — installed once at start-up. */
export const installPresentationControls = (): void => {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isPresenting()) exitPresentation();
  });

  // Escape inside fullscreen never reaches the page; the browser leaves
  // fullscreen and says so. If it was ours, that is the way out.
  const onFullscreenChange = (): void => {
    if (isPresenting() && requestedFullscreen && !fullscreenActive()) exitPresentation();
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  document.addEventListener('pointerup', (event) => {
    if (!isPresenting()) return;
    if ((event.target as HTMLElement | null)?.closest?.('.presentation-bar')) return;
    showBar();
  });
};
