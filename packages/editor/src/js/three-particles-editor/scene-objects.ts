/**
 * Scene objects the editor can place alongside the particle system: boxes to
 * build a space out of, lights to shade it, and a light probe for indirect
 * light.
 *
 * The particle config describes one emitter; these live beside it and are
 * persisted separately so a scene survives switching between particle presets.
 */
import * as THREE from 'three';
import { LightProbeGenerator } from 'three/examples/jsm/lights/LightProbeGenerator.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import {
  getScene,
  getRenderer,
  getCamera,
  getRendererDomElement,
  getOrbitControls,
  setOutputCamera,
  setSsrSettings,
  defaultSsrSettings,
  setEnvironment,
  defaultEnvironmentSettings,
} from './world';
import type { SsrSettings, EnvironmentSettings } from './world';
import { markAsEditorOnly } from './editor-layers';
import { isPlayer } from './runtime-mode';

const STORAGE_KEY = 'particle-system-editor/scene-objects';

export type SceneObjectType =
  | 'BOX'
  | 'SPHERE'
  | 'POINT_LIGHT'
  | 'DIRECTIONAL_LIGHT'
  | 'LIGHT_PROBE'
  | 'CAMERA'
  | 'ENVIRONMENT'
  | 'FRAME';

/** Types the rotate gizmo means something for. */
const rotatable = (type?: SceneObjectType): boolean =>
  type === 'BOX' || type === 'SPHERE' || type === 'CAMERA' || type === 'FRAME';

/** Types the scale gizmo means something for. */
const scalable = (type?: SceneObjectType): boolean => type === 'BOX' || type === 'SPHERE';

/** Types built from a shape rather than scaled from a unit primitive. */
const parametric = (type?: SceneObjectType): boolean => type === 'FRAME';

export type Vec3 = { x: number; y: number; z: number };

export type SceneObject = {
  id: string;
  type: SceneObjectType;
  name: string;
  visible: boolean;
  position: Vec3;
  /** BOX and SPHERE: non-uniform scale of the base shape. */
  size?: Vec3;
  rotation?: Vec3;
  color?: string;
  roughness?: number;
  metalness?: number;
  emissive?: string;
  emissiveIntensity?: number;
  /** Render the inside instead of the outside — for a room built from one box. */
  insideOut?: boolean;
  /** Lights only. */
  intensity?: number;
  /**
   * DIRECTIONAL_LIGHT only: the point it aims at. A directional light's
   * direction is the vector from its position to this target — its rotation is
   * meaningless, which is why the gizmo offers no rotate mode for it.
   */
  target?: Vec3;
  /** Point light only; 0 means no cutoff. */
  distance?: number;
  decay?: number;
  /** Light probe only. */
  captureHeight?: number;
  includeParticles?: boolean;
  /**
   * LIGHT_PROBE only: the baked spherical-harmonic coefficients, flattened to
   * 27 numbers. Without these a probe comes back black after a reload or a
   * config load, since a fresh THREE.LightProbe starts neutral and nothing
   * re-bakes it automatically.
   */
  sh?: number[];
  /** CAMERA only. */
  fov?: number;
  near?: number;
  far?: number;
  /**
   * Output aspect ratio, which drives the shape of the preview rather than
   * following the viewport — an installation is composed for a fixed frame.
   */
  aspect?: number;
  /**
   * CAMERA only: screen space reflections for this camera's view.
   *
   * Post processing belongs to the camera rather than the editor because it is
   * part of how a shot is composed — two cameras in one scene can reasonably
   * want different settings, and the choice has to survive a reload and travel
   * inside the saved config like every other decision about the artwork.
   */
  ssr?: SsrSettings;
  /**
   * ENVIRONMENT only: a panorama that lights the scene and shows in reflections.
   *
   * It sits with the scene objects rather than in a settings pane because it is
   * part of the artwork — swap the panorama and the whole piece changes — so it
   * has to save, load and travel with the config like a light does.
   */
  environment?: EnvironmentSettings;

  /**
   * FRAME only: a rectangular border, measured the way one is built rather than
   * the way it is drawn — you know the opening you want and how heavy the
   * surround should be, not the outer dimensions those imply.
   */
  innerWidth?: number;
  innerHeight?: number;
  /** Width of the surround, added outside the opening on every side. */
  border?: number;
  /** How far the frame stands off its plane. */
  depth?: number;
  /**
   * The inside of the opening, which is what catches reflections at a grazing
   * angle. Its own material because it is doing a different job from the face:
   * the face is seen head-on, the edge is seen almost edge-on.
   */
  edgeColor?: string;
  edgeRoughness?: number;
  edgeMetalness?: number;
  edgeEmissive?: string;
  edgeEmissiveIntensity?: number;
};

/** Live THREE objects, keyed by scene-object id. */
const live = new Map<string, THREE.Object3D>();
/** Frustum outlines for CAMERA objects, so you can see where one is aimed. */
const frustums = new Map<string, THREE.CameraHelper>();
let objects: SceneObject[] = [];

// ─── Selection and the drag gizmo ────────────────────────────────────────────

let transformControls: TransformControls | null = null;
let selectedId: string | null = null;
/**
 * Notified whenever the stored objects change behind the panel's back — a
 * gizmo drag, or a config load replacing the whole scene — so its list and
 * numbers follow.
 */
let onSceneChanged: (() => void) | null = null;

export const setOnSceneChanged = (fn: (() => void) | null): void => {
  onSceneChanged = fn;
};

export const getSelectedId = (): string | null => selectedId;

/** Creates the gizmo lazily — the world has to exist first. */
const ensureTransformControls = (): TransformControls => {
  if (transformControls) return transformControls;

  const controls = new TransformControls(getCamera(), getRendererDomElement());
  controls.setSpace('world');

  // Orbiting while dragging an axis would fight the gizmo.
  controls.addEventListener('dragging-changed', (event) => {
    getOrbitControls().enabled = !event.value;
  });

  // Write the dragged transform back to the stored object, otherwise the panel
  // and localStorage would still hold the pre-drag values.
  controls.addEventListener('objectChange', () => {
    if (!selectedId) return;
    const three = live.get(selectedId);
    const obj = objects.find((o) => o.id === selectedId);
    if (!three || !obj) return;

    const patch: Partial<SceneObject> = {
      position: { x: three.position.x, y: three.position.y, z: three.position.z },
    };
    if (scalable(obj.type)) {
      patch.size = { x: three.scale.x, y: three.scale.y, z: three.scale.z };
    }
    if (rotatable(obj.type)) {
      patch.rotation = {
        x: THREE.MathUtils.radToDeg(three.rotation.x),
        y: THREE.MathUtils.radToDeg(three.rotation.y),
        z: THREE.MathUtils.radToDeg(three.rotation.z),
      };
    }

    const idx = objects.findIndex((o) => o.id === selectedId);
    objects[idx] = { ...objects[idx], ...patch };
    persist();
    onSceneChanged?.();
  });

  const helper = controls.getHelper();
  markAsEditorOnly(helper);
  getScene().add(helper);
  transformControls = controls;
  return controls;
};

/** Attaches the drag gizmo to an object, or clears it when id is null. */
export const selectSceneObject = (id: string | null): void => {
  selectedId = id;
  // No gizmo in the player — and building one would ask for orbit controls that
  // do not exist there.
  if (isPlayer()) return;
  const controls = ensureTransformControls();
  const three = id ? live.get(id) : null;
  if (three) controls.attach(three);
  else controls.detach();
};

/** Modes that make sense for a given object — lights have no meaningful size,
 * and a directional light's rotation does not steer it. */
export const allowedTransformModes = (
  type: SceneObjectType | undefined
): Array<'translate' | 'rotate' | 'scale'> => [
  'translate',
  ...(rotatable(type) ? (['rotate'] as const) : []),
  ...(scalable(type) ? (['scale'] as const) : []),
];

/** translate | rotate | scale */
export const setTransformMode = (mode: 'translate' | 'rotate' | 'scale'): void => {
  ensureTransformControls().setMode(mode);
};

export const getSceneObject = (id: string | null): SceneObject | undefined =>
  id ? objects.find((o) => o.id === id) : undefined;

export const getTransformMode = (): string =>
  (transformControls?.mode as string) ?? 'translate';

const nextId = () => `obj-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

const DEFAULTS: Record<SceneObjectType, () => Omit<SceneObject, 'id' | 'name'>> = {
  BOX: () => ({
    type: 'BOX',
    visible: true,
    position: { x: 0, y: 1, z: 0 },
    size: { x: 2, y: 2, z: 2 },
    rotation: { x: 0, y: 0, z: 0 },
    color: '#ffffff',
    roughness: 0.9,
    metalness: 0,
    emissive: '#000000',
    emissiveIntensity: 0,
    insideOut: false,
  }),
  SPHERE: () => ({
    type: 'SPHERE',
    visible: true,
    position: { x: 0, y: 1, z: 0 },
    size: { x: 1, y: 1, z: 1 },
    rotation: { x: 0, y: 0, z: 0 },
    color: '#ffffff',
    roughness: 0.9,
    metalness: 0,
    emissive: '#000000',
    emissiveIntensity: 0,
    insideOut: false,
  }),
  POINT_LIGHT: () => ({
    type: 'POINT_LIGHT',
    visible: true,
    position: { x: 0, y: 5, z: 0 },
    color: '#ffffff',
    intensity: 80,
    distance: 0,
    decay: 2,
  }),
  DIRECTIONAL_LIGHT: () => ({
    type: 'DIRECTIONAL_LIGHT',
    visible: true,
    position: { x: 4, y: 6, z: 4 },
    target: { x: 0, y: 0, z: 0 },
    color: '#ffffff',
    intensity: 2,
  }),
  LIGHT_PROBE: () => ({
    type: 'LIGHT_PROBE',
    visible: true,
    position: { x: 0, y: 0, z: 0 },
    intensity: 1,
    captureHeight: 4,
    includeParticles: true,
  }),
  FRAME: () => ({
    type: 'FRAME',
    visible: true,
    position: { x: 0, y: 1.5, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    innerWidth: 6,
    innerHeight: 3.5,
    border: 0.6,
    depth: 0.5,
    // Face: what the viewer sees, matte enough to read as a surround.
    color: '#d8d8d8',
    roughness: 0.6,
    metalness: 0.2,
    emissive: '#000000',
    emissiveIntensity: 0,
    // Edge: mirror-ish but not sharp, which is where the reflections live.
    edgeColor: '#ffffff',
    edgeRoughness: 0.25,
    edgeMetalness: 0.9,
    edgeEmissive: '#000000',
    edgeEmissiveIntensity: 0,
  }),
  ENVIRONMENT: () => ({
    type: 'ENVIRONMENT',
    visible: true,
    // No transform: a panorama surrounds the scene rather than sitting in it.
    position: { x: 0, y: 0, z: 0 },
    environment: defaultEnvironmentSettings(),
  }),
  CAMERA: () => {
    // Born where you are looking from. Framing a shot by flying there and
    // dropping a camera beats typing coordinates, and it matches what every
    // 3D package does with "align camera to view".
    const view = getCamera();
    const euler = new THREE.Euler().setFromQuaternion(view.quaternion, 'XYZ');
    return {
      type: 'CAMERA',
      visible: true,
      position: { x: view.position.x, y: view.position.y, z: view.position.z },
      rotation: {
        x: THREE.MathUtils.radToDeg(euler.x),
        y: THREE.MathUtils.radToDeg(euler.y),
        z: THREE.MathUtils.radToDeg(euler.z),
      },
      fov: view.fov,
      near: 0.1,
      far: 200,
      aspect: 16 / 9,
      ssr: defaultSsrSettings(),
    };
  },
};

const LABEL: Record<SceneObjectType, string> = {
  BOX: 'Box',
  SPHERE: 'Sphere',
  POINT_LIGHT: 'Point Light',
  DIRECTIONAL_LIGHT: 'Directional Light',
  LIGHT_PROBE: 'Light Probe',
  CAMERA: 'Camera',
  ENVIRONMENT: 'Environment',
  FRAME: 'Frame',
};

/**
 * A rectangular border, extruded from a shape with a hole in it.
 *
 * Extrusion rather than four boxes because it produces one watertight mesh with
 * mitred corners, and because it groups its faces: the caps come out as one
 * material slot and the walls as another, which is exactly the split between
 * the face you look at and the inside of the opening.
 */
const buildFrameGeometry = (obj: SceneObject): THREE.ExtrudeGeometry => {
  const innerW = Math.max(0.01, obj.innerWidth ?? 6);
  const innerH = Math.max(0.01, obj.innerHeight ?? 3.5);
  const border = Math.max(0.01, obj.border ?? 0.6);
  const depth = Math.max(0.01, obj.depth ?? 0.5);
  const outerW = innerW + border * 2;
  const outerH = innerH + border * 2;

  const shape = new THREE.Shape();
  shape.moveTo(-outerW / 2, -outerH / 2);
  shape.lineTo(outerW / 2, -outerH / 2);
  shape.lineTo(outerW / 2, outerH / 2);
  shape.lineTo(-outerW / 2, outerH / 2);
  shape.closePath();

  // Wound the opposite way from the outline, which is how a path reads as a hole.
  const hole = new THREE.Path();
  hole.moveTo(-innerW / 2, -innerH / 2);
  hole.lineTo(-innerW / 2, innerH / 2);
  hole.lineTo(innerW / 2, innerH / 2);
  hole.lineTo(innerW / 2, -innerH / 2);
  hole.closePath();
  shape.holes.push(hole);

  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  // Extrusion grows along +Z from the plane; centre it so the object's position
  // is the middle of the frame rather than its back face.
  geometry.translate(0, 0, -depth / 2);
  return geometry;
};

/** The dimensions baked into a frame's geometry, to avoid rebuilding it needlessly. */
const frameGeometryKey = (obj: SceneObject): string =>
  [obj.innerWidth, obj.innerHeight, obj.border, obj.depth].join('/');

const frameKeys = new Map<string, string>();

const buildThreeObject = (obj: SceneObject): THREE.Object3D => {
  switch (obj.type) {
    case 'BOX':
    case 'SPHERE': {
      const geometry =
        obj.type === 'SPHERE'
          ? new THREE.SphereGeometry(0.5, 48, 32)
          : new THREE.BoxGeometry(1, 1, 1);
      // material.dithering has no effect on the WebGPU backend; smooth
      // gradients rely on the renderer's half-float canvas instead.
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    }
    case 'POINT_LIGHT': {
      const light = new THREE.PointLight(0xffffff, 1);
      light.castShadow = false;
      return light;
    }
    case 'DIRECTIONAL_LIGHT': {
      const light = new THREE.DirectionalLight(0xffffff, 1);
      light.castShadow = true;
      light.shadow.mapSize.set(2048, 2048);
      // Without a bias, a lit surface samples its own depth and self-shadows
      // in a regular moire — the stepped/terraced look on flat faces. Point
      // lights here don't cast shadows, which is why only the sun showed it.
      // normalBias does the heavy lifting; the small depth bias cleans up
      // surfaces that face the light almost edge-on.
      light.shadow.normalBias = 0.02;
      light.shadow.bias = -0.0005;
      light.shadow.camera.left = -14;
      light.shadow.camera.right = 14;
      light.shadow.camera.top = 14;
      light.shadow.camera.bottom = -14;
      light.shadow.camera.near = 0.1;
      light.shadow.camera.far = 60;
      return light;
    }
    case 'LIGHT_PROBE':
      // Starts neutral; coefficients are filled in by baking.
      return new THREE.LightProbe();
    case 'CAMERA':
      // Values are pushed on by applyToThree, like every other type.
      return new THREE.PerspectiveCamera();
    case 'ENVIRONMENT':
      // Nothing to draw: the panorama is a scene property, not an object in it.
      // An empty node keeps this type inside the same lifecycle as the rest.
      return new THREE.Object3D();
    case 'FRAME': {
      // Two slots in the order ExtrudeGeometry groups them: caps, then walls.
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), [
        new THREE.MeshStandardMaterial(),
        new THREE.MeshStandardMaterial(),
      ]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    }
  }
};

/** Pushes a scene object's values onto its live THREE object. */
const applyToThree = (obj: SceneObject): void => {
  const three = live.get(obj.id);
  if (!three) return;

  three.visible = obj.visible;
  three.position.set(obj.position.x, obj.position.y, obj.position.z);

  if (obj.type === 'BOX' || obj.type === 'SPHERE') {
    const mesh = three as THREE.Mesh;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mesh.scale.set(obj.size!.x, obj.size!.y, obj.size!.z);
    if (obj.rotation) {
      mesh.rotation.set(
        THREE.MathUtils.degToRad(obj.rotation.x),
        THREE.MathUtils.degToRad(obj.rotation.y),
        THREE.MathUtils.degToRad(obj.rotation.z)
      );
    }
    mat.color.set(obj.color ?? '#ffffff');
    mat.roughness = obj.roughness ?? 0.9;
    mat.metalness = obj.metalness ?? 0;
    mat.emissive.set(obj.emissive ?? '#000000');
    mat.emissiveIntensity = obj.emissiveIntensity ?? 0;
    mat.side = obj.insideOut ? THREE.BackSide : THREE.FrontSide;
    mat.needsUpdate = true;
  } else if (obj.type === 'FRAME') {
    const mesh = three as THREE.Mesh;
    const [face, edge] = mesh.material as THREE.MeshStandardMaterial[];

    const key = frameGeometryKey(obj);
    if (frameKeys.get(obj.id) !== key) {
      mesh.geometry.dispose();
      mesh.geometry = buildFrameGeometry(obj);
      frameKeys.set(obj.id, key);
    }

    if (obj.rotation) {
      mesh.rotation.set(
        THREE.MathUtils.degToRad(obj.rotation.x),
        THREE.MathUtils.degToRad(obj.rotation.y),
        THREE.MathUtils.degToRad(obj.rotation.z)
      );
    }

    face.color.set(obj.color ?? '#d8d8d8');
    face.roughness = obj.roughness ?? 0.6;
    face.metalness = obj.metalness ?? 0.2;
    face.emissive.set(obj.emissive ?? '#000000');
    face.emissiveIntensity = obj.emissiveIntensity ?? 0;
    face.needsUpdate = true;

    edge.color.set(obj.edgeColor ?? '#ffffff');
    edge.roughness = obj.edgeRoughness ?? 0.25;
    edge.metalness = obj.edgeMetalness ?? 0.9;
    edge.emissive.set(obj.edgeEmissive ?? '#000000');
    edge.emissiveIntensity = obj.edgeEmissiveIntensity ?? 0;
    edge.needsUpdate = true;
  } else if (obj.type === 'POINT_LIGHT') {
    const light = three as THREE.PointLight;
    light.color.set(obj.color ?? '#ffffff');
    light.intensity = obj.intensity ?? 0;
    light.distance = obj.distance ?? 0;
    light.decay = obj.decay ?? 2;
  } else if (obj.type === 'DIRECTIONAL_LIGHT') {
    const light = three as THREE.DirectionalLight;
    light.color.set(obj.color ?? '#ffffff');
    light.intensity = obj.intensity ?? 0;
    const t = obj.target ?? { x: 0, y: 0, z: 0 };
    light.target.position.set(t.x, t.y, t.z);
    light.target.updateMatrixWorld();
  } else if (obj.type === 'LIGHT_PROBE') {
    const probe = three as THREE.LightProbe;
    probe.intensity = obj.visible ? (obj.intensity ?? 1) : 0;
    if (obj.sh?.length === 27) probe.sh.fromArray(obj.sh);
  } else if (obj.type === 'CAMERA') {
    const cam = three as THREE.PerspectiveCamera;
    if (obj.rotation) {
      cam.rotation.set(
        THREE.MathUtils.degToRad(obj.rotation.x),
        THREE.MathUtils.degToRad(obj.rotation.y),
        THREE.MathUtils.degToRad(obj.rotation.z)
      );
    }
    cam.fov = obj.fov ?? 45;
    cam.near = obj.near ?? 0.1;
    cam.far = obj.far ?? 200;
    cam.aspect = obj.aspect ?? 16 / 9;
    cam.updateProjectionMatrix();
    // The frustum outline is generated from the projection matrix, so it has to
    // be regenerated whenever any of the four values above move.
    cam.updateMatrixWorld();
    frustums.get(obj.id)?.update();
  }
};

/** Builds an object's THREE counterpart and puts it in the scene. */
const mount = (obj: SceneObject): THREE.Object3D => {
  const three = buildThreeObject(obj);
  live.set(obj.id, three);
  getScene().add(three);
  // A directional light aims at its target's world position, which THREE only
  // computes for objects that are themselves in the graph.
  if (obj.type === 'DIRECTIONAL_LIGHT') {
    getScene().add((three as THREE.DirectionalLight).target);
  }
  // A CameraHelper is a sibling rather than a child: it draws the frustum in
  // world space, so parenting it to the camera would move it with the lens.
  if (obj.type === 'CAMERA' && !isPlayer()) {
    const frustum = new THREE.CameraHelper(three as THREE.PerspectiveCamera);
    markAsEditorOnly(frustum);
    frustums.set(obj.id, frustum);
    getScene().add(frustum);
  }
  applyToThree(obj);
  return three;
};

/** Removes an object's THREE counterpart and frees what it owns. */
const unmount = (id: string): void => {
  frameKeys.delete(id);
  const frustum = frustums.get(id);
  if (frustum) {
    getScene().remove(frustum);
    frustum.dispose();
    frustums.delete(id);
  }
  const three = live.get(id);
  if (!three) return;
  getScene().remove(three);
  if (three instanceof THREE.DirectionalLight) getScene().remove(three.target);
  if ((three as THREE.Mesh).geometry) (three as THREE.Mesh).geometry.dispose();
  const mat = (three as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
  // A frame carries one material per face group, so this can be a list.
  if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
  else if (mat && 'dispose' in mat) mat.dispose();
  live.delete(id);
};

/**
 * Hands world.ts whichever camera the preview should render through: the first
 * visible one. Several cameras can be parked in a scene as alternative framings,
 * and hiding the others is how you choose between them.
 */
/**
 * Hands world.ts the panorama in force: the first visible one. Hiding an
 * environment is how you turn it off without losing the image you loaded.
 */
const syncEnvironment = (): void => {
  const active = objects.find((o) => o.type === 'ENVIRONMENT' && o.visible);
  void setEnvironment({ ...defaultEnvironmentSettings(), ...(active?.environment ?? {}) });
};

const syncOutputCamera = (): void => {
  const active = objects.find((o) => o.type === 'CAMERA' && o.visible);
  setOutputCamera(active ? ((live.get(active.id) as THREE.PerspectiveCamera) ?? null) : null);
  // Reflection settings ride along with the camera they belong to. Cameras saved
  // before this existed have none, and fall back to the defaults switched off.
  setSsrSettings({ ...defaultSsrSettings(), ...(active?.ssr ?? {}) });
  // Only the chosen camera shows its frustum; the rest would be visual noise.
  frustums.forEach((frustum, id) => {
    const obj = objects.find((o) => o.id === id);
    frustum.visible = !!obj?.visible;
  });
};

export const getEnvironmentId = (): string | null =>
  objects.find((o) => o.type === 'ENVIRONMENT' && o.visible)?.id ?? null;

export const getOutputCameraId = (): string | null =>
  objects.find((o) => o.type === 'CAMERA' && o.visible)?.id ?? null;

const persist = (): void => {
  // Riding along with persist rather than being called from each mutation:
  // every path that changes `objects` already ends here, so nothing can add,
  // hide or delete a camera without the preview finding out.
  syncOutputCamera();
  syncEnvironment();
  // The player receives scenes, it does not own them — and it shares an origin
  // with the editor, so persisting here would overwrite the scene the editor is
  // still working on in the other window.
  if (!isPlayer()) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(objects));
    } catch {
      /* quota — the scene still works for this session */
    }
  }
  sceneWatchers.forEach((watcher) => watcher());
};

/**
 * Called after every committed change to the scene, whatever made it.
 *
 * `onSceneChanged` is a single slot owned by the Scene panel; this is the list
 * for everything else that needs to hear about a change — the player link being
 * the first of them.
 */
const sceneWatchers = new Set<() => void>();

export const watchScene = (watcher: () => void): (() => void) => {
  sceneWatchers.add(watcher);
  return () => sceneWatchers.delete(watcher);
};

export const getSceneObjects = (): SceneObject[] => objects;

export const addSceneObject = (type: SceneObjectType): SceneObject => {
  const count = objects.filter((o) => o.type === type).length + 1;
  const obj = {
    id: nextId(),
    name: `${LABEL[type]} ${count}`,
    ...DEFAULTS[type](),
  } as SceneObject;

  objects = [...objects, obj];
  mount(obj);
  persist();
  return obj;
};

/**
 * Copies an object with everything it currently holds — transform, material,
 * light settings — and offsets it slightly so the copy is visible rather than
 * hidden exactly inside the original.
 */
export const duplicateSceneObject = (id: string): SceneObject | null => {
  const source = objects.find((o) => o.id === id);
  if (!source) return null;

  const sameType = objects.filter((o) => o.type === source.type).length + 1;
  const copy: SceneObject = {
    // structuredClone keeps the nested vectors from being shared with the
    // original, which would make the two move together.
    ...structuredClone(source),
    id: nextId(),
    name: `${LABEL[source.type]} ${sameType}`,
    position: {
      x: source.position.x + (source.type === 'LIGHT_PROBE' ? 0 : 0.5),
      y: source.position.y,
      z: source.position.z + (source.type === 'LIGHT_PROBE' ? 0 : 0.5),
    },
  };

  // A probe baked before its coefficients were stored has them only on the
  // live object; take them from there so the copy isn't handed back black.
  if (copy.type === 'LIGHT_PROBE' && !copy.sh) {
    const sourceProbe = live.get(source.id) as THREE.LightProbe | undefined;
    if (sourceProbe) copy.sh = sourceProbe.sh.toArray();
  }

  objects = [...objects, copy];
  mount(copy);
  persist();
  return copy;
};

export const updateSceneObject = (id: string, patch: Partial<SceneObject>): void => {
  const idx = objects.findIndex((o) => o.id === id);
  if (idx < 0) return;
  objects[idx] = { ...objects[idx], ...patch };
  applyToThree(objects[idx]);
  persist();
};

export const removeSceneObject = (id: string): void => {
  if (selectedId === id) selectSceneObject(null);
  unmount(id);
  objects = objects.filter((o) => o.id !== id);
  persist();
};

/**
 * Fits a light probe to the scene as seen from a point above the origin.
 *
 * Where the capture happens matters: a flat emissive surface covers almost no
 * solid angle when sampled level with it, so the probe would come back nearly
 * black. Sampling from above puts it across the lower hemisphere.
 */
export const bakeLightProbe = async (id: string): Promise<void> => {
  const obj = objects.find((o) => o.id === id);
  const probe = live.get(id) as THREE.LightProbe | undefined;
  if (!obj || !probe) return;

  const scene = getScene();
  const renderer = getRenderer() as unknown as THREE.WebGLRenderer;

  const target = new THREE.WebGLCubeRenderTarget(128, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    generateMipmaps: false,
  });
  const cubeCamera = new THREE.CubeCamera(0.1, 200, target);
  cubeCamera.position.set(
    obj.position.x,
    obj.position.y + (obj.captureHeight ?? 4),
    obj.position.z
  );

  // The probe must not see its own contribution, or repeated bakes runaway.
  const probeWasVisible = probe.visible;
  probe.visible = false;

  let hidden: THREE.Object3D | null = null;
  if (!obj.includeParticles) {
    scene.children.forEach((child) => {
      let hasParticles = false;
      child.traverse((o) => {
        if ((o as THREE.Mesh).geometry?.type === 'InstancedBufferGeometry') hasParticles = true;
        if ((o as any).geometry?.isInstancedBufferGeometry) hasParticles = true;
      });
      if (hasParticles) hidden = child;
    });
    if (hidden) (hidden as THREE.Object3D).visible = false;
  }

  cubeCamera.update(renderer, scene);

  if (hidden) (hidden as THREE.Object3D).visible = true;
  probe.visible = probeWasVisible;

  const fitted = await LightProbeGenerator.fromCubeRenderTarget(renderer, target);
  probe.sh.copy(fitted.sh);
  probe.intensity = obj.visible ? (obj.intensity ?? 1) : 0;
  target.dispose();

  // Keep the result with the object, not just on the live probe, so the bake
  // survives a reload and travels with a saved config.
  const idx = objects.findIndex((o) => o.id === id);
  if (idx >= 0) {
    objects[idx] = { ...objects[idx], sh: probe.sh.toArray() };
    persist();
  }
};

/** Rebuilds every stored object into the current scene. Call once on startup. */
export const initSceneObjects = (): void => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    objects = Array.isArray(raw) ? raw : [];
  } catch {
    objects = [];
  }

  objects.forEach(mount);
  syncOutputCamera();
  syncEnvironment();
};

/**
 * Swaps the whole scene for another one — how a loaded config brings its
 * lights, boxes and probes with it.
 *
 * The incoming objects are cloned: they arrive as part of a parsed config, and
 * editing them afterwards must not write back into it.
 */
export const replaceSceneObjects = (next: SceneObject[]): void => {
  selectSceneObject(null);
  objects.forEach((obj) => unmount(obj.id));
  objects = structuredClone(next);
  objects.forEach(mount);
  persist();
  onSceneChanged?.();
};
