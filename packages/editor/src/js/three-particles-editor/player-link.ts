/**
 * The wire between the editor and the display window.
 *
 * Both windows are the same app on the same origin, so they can talk over a
 * BroadcastChannel — structured clone, no size ceiling worth worrying about,
 * and no dependency on the opener reference surviving.
 *
 * What travels is plain config data, never THREE objects. Textures are the one
 * thing deliberately left out: uploaded images live in localStorage, which the
 * player already shares, so re-sending the data URLs would double every message
 * for nothing. The day the player becomes a standalone site on its own origin,
 * `embeddedTextures` goes back into the snapshot and nothing else changes.
 */
export const PLAYER_CHANNEL = 'three-particles-player';

/** Named so a second toggle re-focuses the window instead of opening another. */
export const PLAYER_WINDOW_NAME = 'three-particles-player';

export const PLAYER_URL = 'player.html';

export type PlayerMessage =
  /** Player → editor: I am up, send me everything. */
  | { type: 'hello' }
  /**
   * Editor → player: the whole piece — emitter, scene, camera.
   *
   * `elapsed` is the editor's clock at the moment of sending. The emitter's
   * canned motion is a pure function of it, so handing it over once lets the
   * display put the emitter at the same point of its circle rather than
   * somewhere else on the same circle. Only that motion is synchronised: the
   * particles themselves are simulated independently on each side and always
   * will be.
   */
  | { type: 'snapshot'; config: any; elapsed: number }
  /** Editor → player: the emitter changed; the scene is untouched. */
  | { type: 'particles'; config: any }
  /** Editor → player: the scene changed; the emitter is untouched. */
  | { type: 'scene'; objects: any[] }
  /** Editor → player: the editor is going away. */
  | { type: 'closing' }
  /** Editor → player: close yourself. */
  | { type: 'shutdown' }
  /** Player → editor: I am going away; stop pushing. */
  | { type: 'bye' };

/**
 * Stands in for a panorama the display already has.
 *
 * A scene message goes out on every committed change, and an environment's
 * source is a data URL that can run to several megabytes — re-cloning it
 * through the channel eight times a second while a slider moves is a cost with
 * no benefit, since the pixels cannot have changed without the source changing
 * with them.
 */
export const KEEP_EXISTING = '\u0000keep-existing';

/**
 * Strips what must not travel: the texture payloads (see above), anything that
 * is not plain data, and — for emitter-only pushes — the scene, which has its
 * own message and its own incremental apply on the far side.
 *
 * The JSON round trip is the point, not laziness. A live config carries
 * THREE objects and the entries' own recreate callbacks, none of which survive
 * a structured clone; going through JSON drops exactly what a save drops, so
 * what the display receives is what a saved file would have contained.
 */
export const forWire = (config: any, { withScene }: { withScene: boolean }): any => {
  const editorData = { ...(config._editorData ?? {}) };
  delete editorData.embeddedTextures;
  if (!withScene) delete editorData.sceneObjects;

  return JSON.parse(
    JSON.stringify({ ...config, _editorData: editorData }, (_key, value) => {
      if (typeof value === 'function') return undefined;
      if (value?.isTexture || value?.isBufferGeometry || value?.isMaterial) return undefined;
      return value;
    })
  );
};

/**
 * Trailing throttle.
 *
 * Every push is a full config, and a slider drag fires dozens per second. The
 * trailing edge is the one that matters — it carries the value the user landed
 * on — so intermediate pushes are dropped rather than queued.
 */
export const throttleTrailing = <T extends unknown[]>(
  fn: (...args: T) => void,
  ms: number
): ((...args: T) => void) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: T | null = null;

  return (...args: T) => {
    latest = args;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (latest) fn(...latest);
      latest = null;
    }, ms);
  };
};
