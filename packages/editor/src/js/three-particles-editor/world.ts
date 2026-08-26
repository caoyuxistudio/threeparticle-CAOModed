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
  vec2,
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
  debug: 'off' | 'color' | 'normal' | 'metalrough' | 'reflection';
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

let ssrSettings: SsrSettings = {
  enabled: false,
  quality: 0.5,
  blurQuality: 2,
  maxDistance: 8,
  thickness: 0.1,
  opacity: 1,
  debug: 'off',
};

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
  const normalNode = colorToDirection(scenePass.getTextureNode('normal'));
  const metalRough = scenePass.getTextureNode('metalrough');

  ssrPass = ssr(colorNode, depthNode, normalNode, metalRough.r, metalRough.g, camera);

  debugNodes = {
    off: blendColor(colorNode, ssrPass),
    color: colorNode,
    normal: scenePass.getTextureNode('normal'),
    metalrough: metalRough,
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

  // TEMP DEBUG
  (window as any).__world = {
    scene, camera, controls, renderer, THREE,
    updateLightProbe, getLightProbe, removeLightProbe,
    getOutputCamera, isPreviewVisible, freeViewportBounds,
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

/** Fraction of the free viewport width the corner preview occupies. */
const PREVIEW_WIDTH_RATIO = 0.3;
const PREVIEW_MARGIN = 16;
const PREVIEW_BORDER = 2;
/**
 * The canvas spans the whole window and the side panels float on top of it, so
 * the preview has to dodge them or it renders underneath. Their widths change
 * when a panel collapses, hence measuring rather than hard-coding — but reading
 * layout every frame would thrash, so the answer is cached briefly.
 */
const PREVIEW_BOUNDS_TTL_MS = 250;
let previewBounds = { left: 0, right: 0 };
let previewBoundsAt = 0;

const freeViewportBounds = (): { left: number; right: number } => {
  const now = performance.now();
  if (now - previewBoundsAt < PREVIEW_BOUNDS_TTL_MS) return previewBounds;
  previewBoundsAt = now;

  const rightPanel = document.querySelector('.right-panel');
  const leftPanel = document.querySelector('.panel-content');
  previewBounds = {
    left: leftPanel ? leftPanel.getBoundingClientRect().right : 0,
    right: rightPanel ? rightPanel.getBoundingClientRect().left : window.innerWidth,
  };
  return previewBounds;
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
  const free = freeViewportBounds();
  const w = Math.round(Math.max(160, (free.right - free.left) * PREVIEW_WIDTH_RATIO));
  const h = Math.round(w / outputCamera.aspect);
  const x = Math.round(free.right - w - PREVIEW_MARGIN);
  const y = PREVIEW_MARGIN;

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

  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, size.x, size.y);
  renderer.setScissor(0, 0, size.x, size.y);
  renderer.setClearColor(previousClear, previousAlpha);
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
