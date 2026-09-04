/**
 * The editor's half of the display window.
 *
 * Conceptually a Window node: the piece keeps being edited here, and a second
 * window shows nothing but what the output camera sees, at the frame's own
 * aspect, with no furniture. It is a separate window rather than a tab on
 * purpose — a hidden tab has its animation frames suspended by the browser, so
 * a tab would freeze the moment you looked at it.
 *
 * The two windows are independent instances: separate renderers, separate GPU
 * devices, separate copies of every texture. That costs frame rate on both
 * sides and is the accepted price of seeing the output full size while still
 * holding the sliders.
 */
import {
  PLAYER_CHANNEL,
  PLAYER_URL,
  PLAYER_WINDOW_NAME,
  KEEP_EXISTING,
  forWire,
  throttleTrailing,
  type PlayerMessage,
} from './player-link';
import { getOutputCamera, isPreviewVisible, canvasBounds, previewRect } from './world';
import { getSceneObjects, watchScene } from './scene-objects';

/** How long a burst of edits is collapsed before the display is told. */
const PUSH_THROTTLE_MS = 120;

let channel: BroadcastChannel | null = null;
let playerWindow: Window | null = null;
/**
 * A display is listening.
 *
 * Not the same question as "did this editor open a window": the player page can
 * be opened by hand, reloaded, or moved to another screen, and it announces
 * itself either way. Pushes follow this flag, the button follows both.
 */
let linked = false;
let button: HTMLButtonElement | null = null;
let snapshotSource: (() => { config: any; elapsed: number }) | null = null;
let unwatchScene: (() => void) | null = null;

/**
 * How the link reads the piece, and the clock the emitter's motion runs on.
 * Registered by the editor rather than imported, because both live in the
 * module that imports this one.
 */
export const setSnapshotSource = (fn: () => { config: any; elapsed: number }): void => {
  snapshotSource = fn;
};

export const isPlayerWindowOpen = (): boolean => !!playerWindow && !playerWindow.closed;

const post = (message: PlayerMessage): void => {
  channel?.postMessage(message);
};

/** The whole piece: emitter, scene, camera, reflections. */
const pushSnapshot = (): void => {
  const source = snapshotSource?.();
  if (!source) return;
  const { config, elapsed } = source;
  // A display that just came up has nothing to keep, so the snapshot always
  // carries the panoramas in full — and reseeds what the sentinel refers to.
  sentPanoramas.clear();
  getSceneObjects().forEach((object: any) => {
    if (object.environment?.source) sentPanoramas.set(object.id, object.environment.source);
  });
  post({ type: 'snapshot', config: forWire(config, { withScene: true }), elapsed });
};

const pushParticles = throttleTrailing((): void => {
  if (!linked) return;
  const config = snapshotSource?.().config;
  if (!config) return;
  post({ type: 'particles', config: forWire(config, { withScene: false }) });
}, PUSH_THROTTLE_MS);

/** The panorama each object was last seen carrying, keyed by object id. */
const sentPanoramas = new Map<string, string>();

/**
 * Scene objects, with any unchanged panorama replaced by a sentinel.
 *
 * Everything else on a scene object is a number, a string or a short array, so
 * only the environment source is worth this treatment — and it is worth it: it
 * alone can be larger than the rest of the piece put together.
 */
const sceneForWire = (): any[] =>
  getSceneObjects().map((object) => {
    const copy: any = structuredClone(object);
    const source = copy.environment?.source;
    if (!source) return copy;

    if (sentPanoramas.get(copy.id) === source) copy.environment.source = KEEP_EXISTING;
    else sentPanoramas.set(copy.id, source);
    return copy;
  });

const pushScene = throttleTrailing((): void => {
  if (!linked) return;
  post({ type: 'scene', objects: sceneForWire() });
}, PUSH_THROTTLE_MS);

/**
 * Announces an emitter change. Called from the editor's recreate path, which is
 * the one funnel every parameter change already goes through.
 */
export const notifyParticleConfigChanged = (): void => {
  pushParticles();
};

/**
 * Opened at editor start-up, not when the button is pressed.
 *
 * The display announces itself whenever it comes up — including a reload, or
 * someone opening player.html directly — and an editor that only starts
 * listening when it opened the window itself would miss all of those.
 */
const ensureChannel = (): void => {
  if (channel) return;
  channel = new BroadcastChannel(PLAYER_CHANNEL);
  channel.onmessage = (event: MessageEvent<PlayerMessage>) => {
    const message = event.data;
    if (message?.type === 'hello') {
      linked = true;
      // Anything that touches the scene — a dragged light, a resized frame, an
      // SSR slider — lands in persist(), so one subscription covers the lot.
      unwatchScene = unwatchScene ?? watchScene(() => pushScene());
      pushSnapshot();
    } else if (message?.type === 'bye') {
      linked = false;
    }
  };
};

export const openPlayerWindow = (): void => {
  ensureChannel();

  const aspect = getOutputCamera()?.aspect || 16 / 9;
  const width = Math.min(1280, Math.round(window.screen.availWidth * 0.6));
  const height = Math.round(width / aspect);
  const features = [
    'popup=yes',
    `width=${width}`,
    `height=${height}`,
    `left=${Math.max(0, Math.round((window.screen.availWidth - width) / 2))}`,
    `top=${Math.max(0, Math.round((window.screen.availHeight - height) / 2))}`,
  ].join(',');

  playerWindow = window.open(PLAYER_URL, PLAYER_WINDOW_NAME, features);

  // A blocked popup comes back as null and would otherwise look like a dead
  // button. Say so once, where the click happened.
  if (!playerWindow) {
    // eslint-disable-next-line no-alert
    window.alert(
      'The display window was blocked by the browser.\n\n' +
        'Allow pop-ups for this site, or open ' +
        new URL(PLAYER_URL, window.location.href).href +
        ' in a second window yourself — it connects on its own.'
    );
    return;
  }

  playerWindow.focus();
};

export const closePlayerWindow = (): void => {
  // A display this editor did not open cannot be closed from here, so it is
  // asked to close itself as well.
  post({ type: 'shutdown' });
  playerWindow?.close();
  playerWindow = null;
  linked = false;
  unwatchScene?.();
  unwatchScene = null;
};

export const togglePlayerWindow = (): void => {
  if (isPlayerWindowOpen() || linked) closePlayerWindow();
  else openPlayerWindow();
};

// ─── The button ──────────────────────────────────────────────────────────────
//
// It sits just outside the preview's left edge, where the preview's own resize
// grip already taught the eye to look for controls. The preview is drawn by the
// renderer into a scissor rectangle rather than being a DOM element, so the
// button is positioned against that rectangle each frame instead of being laid
// out next to it.

const BUTTON_SIZE = 26;
const BUTTON_GAP = 6;

export const installPlayerButton = (): void => {
  if (button) return;

  button = document.createElement('button');
  button.className = 'player-window-toggle material-icons';
  button.title = 'Toggle Full Screen Mode — opens the output camera in its own window';
  button.textContent = 'open_in_new';
  button.style.cssText = [
    'position:fixed',
    'z-index:9',
    `width:${BUTTON_SIZE}px`,
    `height:${BUTTON_SIZE}px`,
    'padding:0',
    'display:none',
    'align-items:center',
    'justify-content:center',
    'border:1px solid #555',
    'border-radius:3px',
    'background:#2b2b2b',
    'color:#ddd',
    'font-size:15px',
    'line-height:1',
    'cursor:pointer',
  ].join(';');

  ensureChannel();

  button.addEventListener('click', (event) => {
    event.preventDefault();
    togglePlayerWindow();
    syncPlayerButton();
  });

  document.body.appendChild(button);
};

/**
 * Keeps the button pinned to the preview and showing the right state.
 *
 * Called once a frame: the preview moves whenever a panel collapses or the
 * output frame changes shape, and the window can be closed from its own title
 * bar without telling anyone.
 */
export const syncPlayerButton = (): void => {
  if (!button) return;

  const visible = !!getOutputCamera() && isPreviewVisible();
  if (!visible) {
    button.style.display = 'none';
    return;
  }

  const canvas = canvasBounds();
  const { x, y } = previewRect();
  button.style.display = 'flex';
  button.style.left = `${Math.round(canvas.left + x - BUTTON_SIZE - BUTTON_GAP)}px`;
  button.style.top = `${Math.round(canvas.top + y)}px`;

  const open = isPlayerWindowOpen() || linked;
  button.textContent = open ? 'close_fullscreen' : 'open_in_new';
  button.style.background = open ? '#b34a2c' : '#2b2b2b';
  button.style.color = open ? '#fff' : '#ddd';
  button.style.borderColor = open ? '#b34a2c' : '#555';

  // A window this editor opened can be closed from its own title bar without
  // saying anything, so its absence is noticed here rather than announced.
  if (playerWindow?.closed) playerWindow = null;
};
