/**
 * The display window.
 *
 * A second instance of the same world, showing the output camera and nothing
 * else: no panels, no grid, no gizmos, no preview box. The editor stays where
 * it is and keeps playing, which is the whole point of this being a window
 * rather than a tab — a hidden tab has its animation frames suspended.
 *
 * It is a separate page, so `world.ts` and `scene-objects.ts` — both built on
 * module-level singletons — get a clean set of their own. The cost is a second
 * WebGPU device with its own copy of every texture.
 */
import * as THREE from 'three';

import { setRuntimeMode } from './js/three-particles-editor/runtime-mode';

// Before anything reads it. Everything downstream checks the mode lazily, at
// call time, so this only has to happen before the first call — but putting it
// at the very top removes the question.
setRuntimeMode('player');

import { updateParticleSystems } from '@newkrok/three-particles';
import { enableWebGPU } from '@newkrok/three-particles/webgpu';

import {
  createWorld,
  fitPlayerCanvas,
  getDepthTexture,
  getOutputCamera,
  getScene,
  renderPlayer,
  toggleStats,
} from './js/three-particles-editor/world';
import { getTexture, initAssets, loadCustomAssets } from './js/three-particles-editor/assets';
import { ensureVideoTexture, loadVideoTextures } from './js/three-particles-editor/video-textures';
import { buildParticleSystem } from './js/three-particles-editor/particle-factory';
import { loadParticleSystem } from './js/three-particles-editor/save-and-load';
import {
  getSceneObjects,
  replaceSceneObjects,
  updateSceneObject,
} from './js/three-particles-editor/scene-objects';
import { applySimulation, resetSimulation } from './js/three-particles-editor/simulation';
import { TextureId } from './js/three-particles-editor/texture-config';
import {
  KEEP_EXISTING,
  PLAYER_CHANNEL,
  type PlayerMessage,
} from './js/three-particles-editor/player-link';

type CycleData = {
  pauseStartTime: number;
  totalPauseTime: number;
  now: number;
  delta: number;
  elapsed: number;
};

const cycleData: CycleData = { pauseStartTime: 0, totalPauseTime: 0, now: 0, delta: 0, elapsed: 0 };

/**
 * Only `_editorData.textureId` has to be here: the loader keeps whatever
 * `_editorData` it finds and merges the incoming config's over it, so the
 * editor's defaults arrive with the first snapshot.
 */
const particleSystemConfig: any = {
  _editorData: { textureId: TextureId.POINT },
};

let clock: THREE.Clock;
let particleSystem: any = null;
let particleSystemContainer: THREE.Object3D;
let webGPUAvailable = false;
let lastAspect = 0;
let hasContent = false;
/**
 * Wall-clock instant the editor's clock read zero, derived from the snapshot.
 *
 * The emitter's canned motion is a pure function of elapsed time, so sharing
 * the origin once puts both windows at the same point of the same circle. Null
 * until a snapshot arrives, and then it is never renegotiated — both clocks run
 * off wall time, so they do not drift apart.
 */
let simulationOrigin: number | null = null;

const status = (): HTMLElement | null => document.querySelector('.player-status');

const showStatus = (text: string): void => {
  const element = status();
  if (!element) return;
  element.textContent = text;
  element.style.display = text ? 'block' : 'none';
};

// ─── Rebuilding ──────────────────────────────────────────────────────────────

/**
 * The player's whole recreate path.
 *
 * No live-update branch and no throttle: the editor already decided what a
 * change means, and by the time it reaches the wire it has been collapsed into
 * one message. Rebuilding outright is also what keeps this short enough to stay
 * obviously equivalent to the editor's version.
 */
const recreateParticleSystem = (): void => {
  if (particleSystem) {
    particleSystem.dispose();
    particleSystem = null;
    cycleData.totalPauseTime = 0;
  }

  particleSystem = buildParticleSystem(particleSystemConfig, {
    webGPUAvailable,
    depthTexture: getDepthTexture(),
  });
  particleSystemContainer.add(particleSystem.instance);
};

/**
 * Applies a scene without tearing it down when it has not structurally changed.
 *
 * `replaceSceneObjects` unmounts and rebuilds everything, which re-extrudes
 * frame geometry and re-prefilters the panorama — a visible hitch on every
 * dragged slider. Matching ids mean the existing objects can simply be updated,
 * and both the frame's geometry cache and the environment's prefilter cache
 * then do their job.
 */
const applyScene = (incoming: any[]): void => {
  const current = getSceneObjects();

  // An unchanged panorama travels as a sentinel rather than as megabytes of
  // data URL; put back the one already in hand before anything compares them.
  const next = incoming.map((object: any) => {
    if (object.environment?.source !== KEEP_EXISTING) return object;
    const existing: any = current.find((o) => o.id === object.id);
    return {
      ...object,
      environment: { ...object.environment, source: existing?.environment?.source ?? '' },
    };
  });
  const sameShape =
    current.length === next.length &&
    current.every((obj, i) => obj.id === next[i].id && obj.type === next[i].type);

  if (!sameShape) {
    replaceSceneObjects(next);
    return;
  }

  next.forEach((obj) => {
    const before = current.find((o) => o.id === obj.id);
    if (JSON.stringify(before) !== JSON.stringify(obj)) updateSceneObject(obj.id, obj);
  });
};

const applyConfig = (config: any): void => {
  // The editor's Helper panel does this on load too: a new piece starts from
  // the origin rather than wherever the previous one's motion left the emitter.
  resetSimulation(particleSystemContainer);

  loadParticleSystem({
    config,
    particleSystemConfig,
    recreateParticleSystem,
  });
  hasContent = true;
  showStatus(getOutputCamera() ? '' : 'This piece has no visible output camera.');

  // A video uploaded after this window opened is on disk but not yet in hand:
  // fetch it by name and build again once it plays. Images cannot arrive this
  // way — they are read once at start-up — which is a limit this leaves alone.
  const source = particleSystemConfig._editorData?.colorInstanceTextureId;
  if (source && !getTexture(source)) {
    void ensureVideoTexture(source).then((video) => {
      if (!video || particleSystemConfig._editorData?.colorInstanceTextureId !== source) return;
      if (particleSystemConfig.particleColorInstance)
        particleSystemConfig.particleColorInstance.map = video.map;
      recreateParticleSystem();
    });
  }
};

// ─── The link ────────────────────────────────────────────────────────────────

const channel = new BroadcastChannel(PLAYER_CHANNEL);

const listen = (): void => {
  channel.onmessage = (event: MessageEvent<PlayerMessage>) => {
    const message = event.data;
    if (!message) return;

    if (message.type === 'snapshot') {
      simulationOrigin = Date.now() - message.elapsed * 1000;
      applyConfig(message.config);
    } else if (message.type === 'particles') {
      // No sceneObjects key, so the loader leaves the scene alone — the whole
      // reason the emitter and the scene travel separately.
      applyConfig(message.config);
    } else if (message.type === 'scene') {
      applyScene(message.objects);
      if (hasContent)
        showStatus(getOutputCamera() ? '' : 'This piece has no visible output camera.');
    } else if (message.type === 'closing') {
      showStatus('The editor closed.');
    } else if (message.type === 'shutdown') {
      // Only works for a window that was opened by script; one opened by hand
      // stays put and says so instead.
      window.close();
      showStatus('Disconnected. Close this window.');
    }
  };

  // The editor cannot know when this page is ready, so the page says so. This
  // is also what a reload does, which is why the editor listens from start-up
  // rather than only after it opened a window itself.
  channel.postMessage({ type: 'hello' } satisfies PlayerMessage);

  // Stop the editor pushing into a window that is going away.
  window.addEventListener('pagehide', () => {
    channel.postMessage({ type: 'bye' } satisfies PlayerMessage);
  });
};

// ─── Presentation ────────────────────────────────────────────────────────────

/**
 * Fullscreen, and a cursor that gets out of the way.
 *
 * The window is already chrome-free; fullscreen is for the moment it goes on
 * the actual wall.
 */
const installPresentationControls = (): void => {
  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  };

  document.addEventListener('keydown', (event) => {
    if (event.key === 'f' || event.key === 'F') toggleFullscreen();
    // The counter is on by default because this window exists to be measured
    // against the editor's. On a wall it is one keystroke away from gone.
    if (event.key === 's' || event.key === 'S') toggleStats();
  });
  document.addEventListener('dblclick', toggleFullscreen);

  let idle: ReturnType<typeof setTimeout> | null = null;
  const wake = (): void => {
    document.body.style.cursor = '';
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      document.body.style.cursor = 'none';
    }, 2000);
  };
  document.addEventListener('mousemove', wake);
  wake();
};

// ─── Frame ───────────────────────────────────────────────────────────────────

const animate = (): void => {
  const rawDelta = clock.getDelta();
  cycleData.now = Date.now() - cycleData.totalPauseTime;
  cycleData.delta = rawDelta > 0.1 ? 0.1 : rawDelta;
  cycleData.elapsed = clock.getElapsedTime();

  // The emitter's own canned motion, before the particles are stepped — the
  // order the editor uses, and the one WORLD simulation space depends on, since
  // it decides where a particle is born.
  const simulation = particleSystemConfig._editorData?.simulation;
  if (simulation) {
    // The editor's clock, not this window's — only for the emitter's motion.
    // The particles below keep stepping on the local delta.
    const elapsed =
      simulationOrigin === null ? cycleData.elapsed : (Date.now() - simulationOrigin) / 1000;
    applySimulation(particleSystemContainer, simulation, elapsed);
  }

  updateParticleSystems(cycleData);

  // The frame's shape is the camera's, and the camera can be swapped or
  // re-lensed from the editor at any moment.
  const aspect = getOutputCamera()?.aspect ?? 0;
  if (aspect && aspect !== lastAspect) {
    lastAspect = aspect;
    fitPlayerCanvas();
  }

  const softParticlesEnabled = !!particleSystemConfig.renderer?.softParticles?.enabled;
  renderPlayer(softParticlesEnabled, particleSystemContainer, particleSystem?.computeNode ?? null);

  requestAnimationFrame(animate);
};

const start = async (): Promise<void> => {
  clock = new THREE.Clock();

  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        enableWebGPU();
        webGPUAvailable = true;
      }
    }
  } catch {
    // WebGPU not available — engine will use GLSL ShaderMaterial fallback
  }

  await createWorld('#player-stage');
  fitPlayerCanvas();

  particleSystemContainer = new THREE.Object3D();
  getScene().add(particleSystemContainer);

  // The uploaded textures a config refers to live in localStorage, which this
  // window shares with the editor — so they are read here the same way, and the
  // wire never has to carry image data.
  initAssets(() => {
    const customTextures =
      JSON.parse(localStorage.getItem('particle-system-editor/library') || '[]') || [];
    const imageTextures =
      JSON.parse(localStorage.getItem('particle-system-editor/image-textures') || '[]') || [];
    loadCustomAssets({
      textures: [...customTextures, ...imageTextures].map(
        ({ name, url }: { name: string; url: string }) => ({ id: name, url })
      ),
      onComplete: () => {
        void loadVideoTextures().then(() => {
          listen();
          animate();
        });
      },
    });
  });

  installPresentationControls();

  (window as any).__player = {
    getConfig: () => particleSystemConfig,
    getSceneObjects,
    getOutputCamera,
    hasContent: () => hasContent,
    // The emitter's own transform, so the canned motion can be checked from
    // outside without reading pixels.
    getEmitterTransform: () => ({
      position: particleSystemContainer.position.toArray(),
      rotation: particleSystemContainer.rotation.toArray().slice(0, 3),
    }),
  };
};

showStatus('Waiting for the editor…');
void start();
