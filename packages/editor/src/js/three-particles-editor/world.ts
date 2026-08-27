import * as THREE from 'three';
import { WebGPURenderer, PostProcessing, QuadMesh, MeshBasicNodeMaterial } from 'three/webgpu';
import {
  pass,
  mrt,
  output,
  normalView,
  metalness,
  roughness,
  blendColor,
  directionToColor,
  colorToDirection,
  sample,
  screenUV,
  vec2,
  vec3,
} from 'three/tsl';
import { ssr } from 'three/examples/jsm/tsl/display/SSRNode.js';

import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LightProbeGenerator } from 'three/examples/jsm/lights/LightProbeGenerator.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { TextureId } from './texture-config';
import { getTexture } from './assets';
import { markAsEditorOnly } from './editor-layers';

let scene: THREE.Scene;
let renderer: WebGPURenderer;
let camera: THREE.PerspectiveCamera;
let controls: OrbitControls;
let stats: Stats;
let mesh: THREE.Mesh;
let lightProbe: THREE.LightProbe | null = null;
let depthRenderTarget: THREE.RenderTarget | null = null;
/**
 * The camera the artwork is framed for, owned by scene-objects.ts and pushed in
 * here. Pushed rather than imported because scene-objects.ts already depends on
 * this module, and a cycle between them would be fragile.
 */
let outputCamera: THREE.PerspectiveCamera | null = null;
let previewVisible = true;

// ─── Screen space reflections ────────────────────────────────────────────────
//
// Post processing runs on the output camera alone: the viewport has to stay
// legible while you work, and reflections of a drag handle would be nonsense.

export type SsrSettings = {
  enabled: boolean;
  /** Ray march step count, 0..1. */
  quality: number;
  /** Box blur radius applied to the reflection buffer. */
  blurQuality: number;
  /** How far a ray travels before giving up, in world units. */
  maxDistance: number;
  /** Depth tolerance when deciding a ray hit something. */
  thickness: number;
  opacity: number;
  /**
   * Which stage of the pipeline to show. SSR is fed by several buffers and a
   * wrong one is invisible in the composite, so being able to look at each in
   * isolation is the difference between tuning and guessing.
   */
  debug: 'off' | 'color' | 'normal' | 'metalrough' | 'metalness' | 'roughness' | 'depth' | 'reflection';
};

let postProcessing: PostProcessing | null = null;
/**
 * Post processing cannot be scissored into a corner. Its internal scene pass
 * obeys whatever scissor is active — three saves and restores the scissor flag
 * around the pass but never clears it — so clipping the output also clips the
 * pass that feeds it, and the whole canvas renders black. The framed view is
 * therefore produced in its own target and blitted into the corner afterwards.
 */
let previewTarget: THREE.RenderTarget | null = null;
let previewBlit: QuadMesh | null = null;
let ssrPass: any = null;
/** The camera the current pipeline was compiled for; rebuilt when it changes. */
let pipelineCamera: THREE.PerspectiveCamera | null = null;

/**
 * Starting values for a new camera.
 *
 * Not the library's own defaults: its maxDistance of 1 is calibrated for a
 * scene a metre across and finds nothing in a room, which reads as "SSR is
 * broken" rather than "the ray gives up too early". These are the values that
 * measurably produce reflections on the test scene.
 */
export const defaultSsrSettings = (): SsrSettings => ({
  enabled: false,
  quality: 1,
  blurQuality: 2,
  maxDistance: 20,
  thickness: 0.15,
  opacity: 1,
  debug: 'off',
});

let ssrSettings: SsrSettings = defaultSsrSettings();

/**
 * Compiles the SSR pipeline for a camera.
 *
 * SSR needs more than a colour buffer: it marches rays against depth and needs
 * a surface's normal and metalness to know what reflects and how sharply. Those
 * come out of a multi-render-target scene pass, which is why this cannot simply
 * wrap the existing render call.
 */
const buildSsrPipeline = (camera: THREE.PerspectiveCamera): void => {
  const scenePass = pass(scene, camera);
  scenePass.setMRT(
    mrt({
      output,
      // Normals are signed but the buffer is not, so they travel encoded.
      normal: directionToColor(normalView),
      metalrough: vec2(metalness, roughness),
    })
  );

  const colorNode = scenePass.getTextureNode('output');
  const depthNode = scenePass.getTextureNode('depth');
  const metalRough = scenePass.getTextureNode('metalrough');
  // Sampled at the screen coordinate rather than handed over as a bare channel.
  // SSR reads metalness with float(), which evaluates a texture node at its
  // default UV — meaningless on the full-screen quad the effect runs on, so the
  // gate `metalness == 0 -> discard` rejected every pixel and the reflection
  // buffer came back empty with every input looking correct.
  const metalnessNode = metalRough.sample(screenUV).r;
  const roughnessNode = metalRough.sample(screenUV).g;

  // The ray march samples neighbouring normals as it walks, so this has to stay
  // something with a `sample(uv)` on it. Decoding the buffer directly with
  // colorToDirection() yields a plain computed node instead, and every step of
  // the loop then throws — which TSL swallows, leaving reflections silently
  // black with correct-looking inputs. `sample()` keeps the decode lazy so the
  // node stays samplable.
  const normalTexture = scenePass.getTextureNode('normal');
  const normalNode = sample((uv) => colorToDirection(normalTexture.sample(uv)));

  ssrPass = ssr(colorNode, depthNode, normalNode, metalnessNode, roughnessNode, camera);

  debugNodes = {
    off: blendColor(colorNode, ssrPass),
    color: colorNode,
    normal: scenePass.getTextureNode('normal'),
    metalrough: metalRough,
    // The two halves of metalrough separately: a combined view is dominated by
    // roughness, which is near 1 almost everywhere and hides whether metalness
    // — the channel SSR actually gates on — made it into the buffer at all.
    metalness: vec3(metalRough.r),
    roughness: vec3(metalRough.g),
    depth: vec3(depthNode),
    reflection: ssrPass,
  };

  postProcessing = new PostProcessing(renderer);
  postProcessing.outputNode = debugNodes[ssrSettings.debug];
  pipelineCamera = camera;
  applySsrUniforms();
};

/** Output nodes for each debug view, rebuilt with the pipeline. */
let debugNodes: Record<string, any> = {};

/** Sizes the offscreen target to the preview box, in device pixels. */
const ensurePreviewTarget = (w: number, h: number): THREE.RenderTarget => {
  const ratio = renderer.getPixelRatio();
  const tw = Math.max(1, Math.round(w * ratio));
  const th = Math.max(1, Math.round(h * ratio));

  if (!previewTarget) {
    previewTarget = new THREE.RenderTarget(tw, th, {
      depthTexture: new THREE.DepthTexture(tw, th),
    });
  } else if (previewTarget.width !== tw || previewTarget.height !== th) {
    previewTarget.setSize(tw, th);
  }

  if (!previewBlit) {
    const material = new MeshBasicNodeMaterial({ map: previewTarget.texture });
    material.depthTest = false;
    material.depthWrite = false;
    previewBlit = new QuadMesh(material);
  }

  return previewTarget;
};

const applySsrUniforms = (): void => {
  if (!ssrPass) return;
  ssrPass.quality.value = ssrSettings.quality;
  ssrPass.blurQuality.value = ssrSettings.blurQuality;
  ssrPass.maxDistance.value = ssrSettings.maxDistance;
  ssrPass.thickness.value = ssrSettings.thickness;
  ssrPass.opacity.value = ssrSettings.opacity;
};

export const setSsrSettings = (patch: Partial<SsrSettings>): void => {
  const previousDebug = ssrSettings.debug;
  ssrSettings = { ...ssrSettings, ...patch };
  applySsrUniforms();

  if (postProcessing && ssrSettings.debug !== previousDebug && debugNodes[ssrSettings.debug]) {
    postProcessing.outputNode = debugNodes[ssrSettings.debug];
    postProcessing.needsUpdate = true;
  }
};

export const getSsrSettings = (): SsrSettings => ssrSettings;

export const setOutputCamera = (cam: THREE.PerspectiveCamera | null): void => {
  outputCamera = cam;
};

export const getOutputCamera = (): THREE.PerspectiveCamera | null => outputCamera;

export const setPreviewVisible = (visible: boolean): void => {
  previewVisible = visible;
};

export const isPreviewVisible = (): boolean => previewVisible;

export const createWorld = async (targetQuery: string): Promise<THREE.Scene> => {
  const container = document.querySelector(targetQuery);
  if (!container) {
    throw new Error(`Container not found: ${targetQuery}`);
  }

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  mesh = new THREE.Mesh(new THREE.PlaneGeometry(50, 50, 50, 50));
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  markAsEditorOnly(mesh);
  scene.add(mesh);
  setTerrain();

  // No lights are created here on purpose. Everything that lights the scene is
  // added from the Scene panel, so an empty scene really is unlit — otherwise a
  // hidden lamp shows up in renders with no control to turn it off.

  // A half-float canvas removes the 8-bit quantisation that bands smooth
  // gradients, such as a point light's falloff across a wall.
  // material.dithering is not implemented on the WebGPU backend, so output
  // precision is the only lever available. Tone mapping already lands in
  // [0,1], so the extended-range canvas changes precision, not brightness.
  renderer = new WebGPURenderer({ antialias: true, outputType: THREE.HalfFloatType });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = 0;
  renderer.toneMappingExposure = 1;
  await renderer.init();
  container.appendChild(renderer.domElement);

  // Create depth render target for soft particles
  depthRenderTarget = new THREE.RenderTarget(window.innerWidth, window.innerHeight, {
    depthTexture: new THREE.DepthTexture(window.innerWidth, window.innerHeight),
  });

  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 100);
  camera.position.set(0, 0, 6);
  // The viewport is the only view that shows the editor's furniture; the output
  // camera keeps its default mask and so sees the artwork layer alone.
  camera.layers.enableAll();

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = true;
  controls.enableZoom = true;
  controls.target.set(0, 0, 0);
  controls.update();

  const statsContainer = document.querySelector('.stats');
  if (!statsContainer) {
    throw new Error('Stats container not found');
  }

  stats = new Stats();
  statsContainer.appendChild(stats.dom);

  window.addEventListener('resize', onWindowResize);
  installPreviewResize(renderer.domElement);

  // TEMP DEBUG
  (window as any).__world = {
    scene, camera, controls, renderer, THREE,
    updateLightProbe, getLightProbe, removeLightProbe,
    getOutputCamera, isPreviewVisible, freeViewportBounds,
    getPreviewScale, setPreviewScale, previewRect, overPreviewHandle, canvasBounds,
    setSsrSettings, getSsrSettings,
    _ssr: () => ({ postProcessing, ssrPass, previewTarget, previewBlit, pipelineCamera }),
  };

  return scene;
};

const onWindowResize = (): void => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (depthRenderTarget) {
    depthRenderTarget.setSize(window.innerWidth, window.innerHeight);
  }
};

export const updateWorld = (
  softParticlesEnabled = false,
  particleContainer?: THREE.Object3D,
  computeNode?: unknown
): void => {
  // Dispatch GPU compute for WebGPU particle simulation
  if (computeNode) {
    (renderer as any).compute(computeNode);
  }

  if (softParticlesEnabled && depthRenderTarget) {
    // Hide particle system during depth pass to avoid feedback loop
    // (the particle shader reads the depth texture that would be written to)
    if (particleContainer) particleContainer.visible = false;
    renderer.setRenderTarget(depthRenderTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    if (particleContainer) particleContainer.visible = true;
  }
  renderer.render(scene, camera);
  renderPreview();
  stats.update();
};

const PREVIEW_MARGIN = 16;
const PREVIEW_BORDER = 2;
/** Side of the square grab area in the preview's bottom-left corner. */
const PREVIEW_HANDLE = 20;
const PREVIEW_MIN_RATIO = 0.15;
/**
 * Lets the preview fill the free area edge to edge. That clears half the screen
 * with both panels open, and collapsing the left one takes it well past that.
 */
const PREVIEW_MAX_RATIO = 1;
const PREVIEW_SCALE_KEY = 'particle-system-editor/preview-scale';

/** Fraction of the free viewport width the preview occupies; drag to change. */
let previewWidthRatio = (() => {
  const stored = Number(localStorage.getItem(PREVIEW_SCALE_KEY));
  return stored >= PREVIEW_MIN_RATIO && stored <= PREVIEW_MAX_RATIO ? stored : 0.3;
})();

export const getPreviewScale = (): number => previewWidthRatio;

export const setPreviewScale = (ratio: number): void => {
  previewWidthRatio = Math.min(PREVIEW_MAX_RATIO, Math.max(PREVIEW_MIN_RATIO, ratio));
  try {
    localStorage.setItem(PREVIEW_SCALE_KEY, String(previewWidthRatio));
  } catch {
    /* quota — the size still applies for this session */
  }
};
/**
 * The canvas spans the whole window and the side panels float on top of it, so
 * the preview has to dodge them or it renders underneath. Their widths change
 * when a panel collapses, hence measuring rather than hard-coding — but reading
 * layout every frame would thrash, so the answer is cached briefly.
 */
const PREVIEW_BOUNDS_TTL_MS = 250;
let previewBounds = { left: 0, right: 0 };
let previewBoundsAt = 0;

/**
 * The canvas does not start at the window's top left — a toolbar sits above it.
 * Viewport and scissor rectangles are relative to the canvas, so everything the
 * preview computes has to be too, or the drawn box and the area that reacts to
 * the mouse end up offset by the height of that toolbar.
 */
const canvasBounds = (): DOMRect => renderer.domElement.getBoundingClientRect();

/** A pointer event in canvas coordinates. */
const toCanvasSpace = (event: PointerEvent): { x: number; y: number } => {
  const rect = canvasBounds();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
};

const freeViewportBounds = (): { left: number; right: number } => {
  const now = performance.now();
  if (now - previewBoundsAt < PREVIEW_BOUNDS_TTL_MS) return previewBounds;
  previewBoundsAt = now;

  const canvas = canvasBounds();
  const rightPanel = document.querySelector('.right-panel');
  const leftPanel = document.querySelector('.panel-content');
  previewBounds = {
    left: leftPanel ? leftPanel.getBoundingClientRect().right - canvas.left : 0,
    right: rightPanel ? rightPanel.getBoundingClientRect().left - canvas.left : canvas.width,
  };
  return previewBounds;
};

/**
 * Where the preview sits, in CSS pixels with the origin at the top left.
 *
 * Rendering and hit-testing both read this, so a dragged handle cannot drift
 * away from the box it is supposed to be attached to.
 */
const previewRect = (): { x: number; y: number; w: number; h: number } => {
  const free = freeViewportBounds();
  const aspect = outputCamera?.aspect || 16 / 9;
  const available = free.right - free.left - PREVIEW_MARGIN * 2;

  let w = Math.round(Math.max(160, available * previewWidthRatio));
  let h = Math.round(w / aspect);

  // A tall output frame would otherwise run off the bottom of the canvas.
  const maxH = canvasBounds().height - PREVIEW_MARGIN * 2;
  if (h > maxH) {
    h = maxH;
    w = Math.round(h * aspect);
  }

  return { x: Math.round(free.right - w - PREVIEW_MARGIN), y: PREVIEW_MARGIN, w, h };
};

/** True when a point in canvas coordinates is inside the resize grip. */
const overPreviewHandle = (px: number, py: number): boolean => {
  if (!outputCamera || !previewVisible) return false;
  const { x, y, h } = previewRect();
  return px >= x - PREVIEW_BORDER && px <= x + PREVIEW_HANDLE && py >= y + h - PREVIEW_HANDLE && py <= y + h + PREVIEW_BORDER;
};

/**
 * Lets the preview be dragged to any size from a corner thumbnail up to most of
 * the viewport, because judging reflections in a 200px box is guesswork.
 *
 * The grip is at the bottom-left because the box is pinned to the top-right:
 * dragging away from the anchor grows it, which is the direction that reads as
 * "bigger". Orbit controls are suspended for the duration so the scene does not
 * spin while resizing.
 */
const installPreviewResize = (canvas: HTMLCanvasElement): void => {
  let dragging = false;
  let startX = 0;
  let startRatio = 0;

  canvas.addEventListener(
    'pointerdown',
    (event) => {
      const point = toCanvasSpace(event);
      if (!overPreviewHandle(point.x, point.y)) return;
      dragging = true;
      startX = point.x;
      startRatio = previewWidthRatio;
      controls.enabled = false;
      canvas.setPointerCapture(event.pointerId);
      event.stopPropagation();
      event.preventDefault();
    },
    true
  );

  canvas.addEventListener('pointermove', (event) => {
    const point = toCanvasSpace(event);
    if (!dragging) {
      canvas.style.cursor = overPreviewHandle(point.x, point.y) ? 'nesw-resize' : '';
      return;
    }
    const free = freeViewportBounds();
    const available = free.right - free.left - PREVIEW_MARGIN * 2;
    // Dragging left is away from the top-right anchor, so it enlarges.
    setPreviewScale(startRatio + (startX - point.x) / available);
    event.stopPropagation();
  });

  const end = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    controls.enabled = true;
    canvas.releasePointerCapture?.(event.pointerId);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
};

/**
 * Draws the output camera's view into the top-right of the free viewport area.
 *
 * Scissoring is what makes this affordable to bolt onto the existing frame: the
 * second render clears and draws only inside the corner rectangle, so the main
 * viewport underneath survives untouched.
 *
 * Coordinates are CSS pixels with the origin at the TOP left — WebGPU's
 * convention, and the opposite of WebGL's.
 */
const renderPreview = (): void => {
  if (!outputCamera || !previewVisible) return;

  const size = renderer.getSize(new THREE.Vector2());
  const { x, y, w, h } = previewRect();

  const previousClear = renderer.getClearColor(new THREE.Color());
  const previousAlpha = renderer.getClearAlpha();

  // Reflections are resolved offscreen first, with no scissor in force.
  if (ssrSettings.enabled) {
    if (pipelineCamera !== outputCamera) buildSsrPipeline(outputCamera);
    const target = ensurePreviewTarget(w, h);
    renderer.setScissorTest(false);
    renderer.setRenderTarget(target);
    postProcessing!.render();
    renderer.setRenderTarget(null);
  }

  renderer.setScissorTest(true);

  // A one-pass border: clear a slightly larger rectangle, then draw inside it.
  const b = PREVIEW_BORDER;
  renderer.setScissor(x - b, y - b, w + b * 2, h + b * 2);
  renderer.setViewport(x - b, y - b, w + b * 2, h + b * 2);
  renderer.setClearColor(0x555555, 1);
  renderer.clear(true, false, false);

  renderer.setScissor(x, y, w, h);
  renderer.setViewport(x, y, w, h);
  renderer.setClearColor(0x000000, 1);
  if (ssrSettings.enabled && previewBlit) {
    previewBlit.render(renderer);
  } else {
    renderer.render(scene, outputCamera);
  }

  // The grip, drawn last so it sits on top of the rendered frame.
  renderer.setScissor(x - PREVIEW_BORDER, y + h - PREVIEW_HANDLE, PREVIEW_HANDLE, PREVIEW_HANDLE + PREVIEW_BORDER);
  renderer.setViewport(x - PREVIEW_BORDER, y + h - PREVIEW_HANDLE, PREVIEW_HANDLE, PREVIEW_HANDLE + PREVIEW_BORDER);
  renderer.setClearColor(0xb34a2c, 1);
  renderer.clear(true, false, false);

  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, size.x, size.y);
  renderer.setScissor(0, 0, size.x, size.y);
  renderer.setClearColor(previousClear, previousAlpha);
};

/**
 * Puts the viewport back on the scene from a three-quarter view.
 *
 * Framing is measured rather than fixed: a scene can be a one-metre prop or a
 * twelve-metre room, and a hard-coded distance would land inside one and miles
 * from the other. Only the artwork layer counts, so the 50m terrain grid does
 * not drag the framing out to nothing.
 */
export const resetCamera = (): void => {
  const artworkOnly = new THREE.Layers();
  artworkOnly.set(0);

  const bounds = new THREE.Box3();
  scene.children.forEach((child) => {
    if (child.visible && child.layers.test(artworkOnly)) bounds.expandByObject(child);
  });

  const target = new THREE.Vector3();
  let radius = 6;
  if (!bounds.isEmpty()) {
    bounds.getCenter(target);
    // GPU-simulated particles move in the shader, so their reported bounds can
    // be anything; clamping keeps one odd object from throwing away the framing.
    radius = THREE.MathUtils.clamp(bounds.getSize(new THREE.Vector3()).length() / 2, 2, 40);
  }

  // 45 degrees around and 45 degrees up — the angle that shows three sides of a
  // box at once, and the one every 3D package calls "home".
  const diagonal = Math.SQRT1_2;
  const direction = new THREE.Vector3(diagonal * diagonal, diagonal, diagonal * diagonal);
  const distance = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.15;

  camera.position.copy(target).addScaledVector(direction, distance);
  // Grow the far plane if the scene outruns it, but never shrink it: the depth
  // range is shared with soft particles and shadows.
  if (distance * 3 > camera.far) {
    camera.far = distance * 3;
    camera.updateProjectionMatrix();
  }

  controls.target.copy(target);
  controls.update();
};

export const setTerrain = (textureId?: string): void => {
  if (!textureId || textureId === TextureId.WIREFRAME) {
    const material = new THREE.MeshBasicMaterial({
      wireframe: true,
      depthWrite: false,
      color: 0x111111,
    });
    mesh.material = material;
    mesh.receiveShadow = false;   // a wireframe grid cannot show a shadow
  } else {
    const { map } = getTexture(textureId);
    map.wrapS = THREE.MirroredRepeatWrapping;
    map.wrapT = THREE.MirroredRepeatWrapping;
    map.repeat.x = 50;
    map.repeat.y = 50;
    map.colorSpace = THREE.SRGBColorSpace;
    // Standard material so the ground actually receives the shadow.
    mesh.material = new THREE.MeshStandardMaterial({
      map,
      roughness: 0.9,
      metalness: 0,
    });
    mesh.receiveShadow = true;
  }
};

/**
 * Captures the scene into a cube map and fits a light probe to it, so surfaces
 * pick up indirect light from their surroundings — the bounce off the white
 * room walls rather than only the direct hit from each lamp.
 *
 * The particle container is hidden during the capture: particles are the thing
 * being lit, and including them would feed their own brightness back into the
 * probe.
 */
export const updateLightProbe = async (
  intensity = 1,
  hideDuringCapture?: THREE.Object3D,
  capturePosition?: THREE.Vector3
): Promise<THREE.LightProbe> => {
  const cubeTarget = new THREE.WebGLCubeRenderTarget(128, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    generateMipmaps: false,
  });
  const cubeCamera = new THREE.CubeCamera(0.1, 100, cubeTarget);
  // Where the probe is sampled matters: a flat emissive sheet contributes
  // almost nothing to a capture taken level with it, because it covers hardly
  // any solid angle from there.
  cubeCamera.position.copy(capturePosition ?? controls.target);

  const wasVisible = hideDuringCapture?.visible;
  if (hideDuringCapture) hideDuringCapture.visible = false;
  if (lightProbe) lightProbe.visible = false;

  cubeCamera.update(renderer as unknown as THREE.WebGLRenderer, scene);

  if (hideDuringCapture && wasVisible !== undefined) {
    hideDuringCapture.visible = wasVisible;
  }

  const probe = await LightProbeGenerator.fromCubeRenderTarget(
    renderer as unknown as THREE.WebGLRenderer,
    cubeTarget
  );

  if (lightProbe) scene.remove(lightProbe);
  lightProbe = probe;
  lightProbe.intensity = intensity;
  scene.add(lightProbe);

  cubeTarget.dispose();
  return lightProbe;
};

export const getLightProbe = (): THREE.LightProbe | null => lightProbe;

export const removeLightProbe = (): void => {
  if (lightProbe) {
    scene.remove(lightProbe);
    lightProbe = null;
  }
};

export const getScene = (): THREE.Scene => scene;
export const getRenderer = () => renderer;
export const getCamera = (): THREE.PerspectiveCamera => camera;
export const getRendererDomElement = (): HTMLCanvasElement => renderer.domElement;
export const getOrbitControls = (): OrbitControls => controls;
export const getDepthTexture = (): THREE.DepthTexture | null =>
  depthRenderTarget?.depthTexture ?? null;

export const captureScreenshot = (): void => {
  // Render the current frame
  renderer.render(scene, camera);

  // Create a temporary canvas with 640x480 resolution
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const context = canvas.getContext('2d');

  if (!context) {
    console.error('Failed to get 2D context for screenshot');
    return;
  }

  // Draw the renderer's canvas to our temporary canvas (this will resize it)
  context.drawImage(renderer.domElement, 0, 0, 640, 480);

  // Convert to WebP and download
  canvas.toBlob(
    (blob) => {
      if (!blob) {
        console.error('Failed to create screenshot blob');
        return;
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      link.download = `particle-effect-${timestamp}.webp`;
      link.href = url;
      link.click();

      // Clean up
      URL.revokeObjectURL(url);
    },
    'image/webp',
    0.95
  );
};
