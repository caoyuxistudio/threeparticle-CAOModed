/**
 * Verification harness. Not part of the app — nothing imports it, and it ships
 * only so that a session can pick it up without being handed it. It is fetched
 * and eval'd from the console after a reload:
 *
 *   await fetch('/__ai-test.js').then(r=>r.text()).then(eval); __t.report()
 *
 * It exists so a change can be checked in two tool calls instead of twenty
 * clicks and screenshots.
 */
(() => {
  const FIXTURE = 'WIP-Test';
  const KEY_SAVED = 'three-particles-saved-configs';
  const KEY_SCENE = 'particle-system-editor/scene-objects';

  const errs = [];
  addEventListener('error', (e) => errs.push('error: ' + e.message));
  addEventListener('unhandledrejection', (e) =>
    errs.push('rejection: ' + (e.reason?.message || e.reason))
  );

  /**
   * The fixture config, read from the example on disk.
   *
   * Examples are the editor's own durable storage: the app fetches them from
   * `public/examples/<name>/config.json` at load time, so unlike a saved config
   * they owe nothing to localStorage and survive a restart or a wiped profile.
   */
  const EXAMPLE_URL = './examples/wip-test/config.json';
  let cached = null;

  const fixture = async () => {
    if (!cached) cached = await (await fetch(EXAMPLE_URL)).json();
    return structuredClone(cached);
  };

  /**
   * What scene-objects.ts currently holds. Reading localStorage rather than the
   * module: persist() writes on every change, so this is the same array that
   * serializeConfig would embed, and it needs no hook in the app.
   */
  const storedScene = () => JSON.parse(localStorage.getItem(KEY_SCENE) || '[]');

  /** Live THREE objects, to catch mounts that leak or never happen. */
  const live = () => {
    const scene = window.__world?.scene;
    if (!scene) return { error: 'no window.__world' };
    const c = { box: 0, sphere: 0, point: 0, dir: 0, probe: 0 };
    scene.children.forEach((o) => {
      if (o.isLightProbe) c.probe++;
      else if (o.isDirectionalLight) c.dir++;
      else if (o.isPointLight) c.point++;
      else if (o.isMesh && o.geometry?.type === 'BoxGeometry') c.box++;
      else if (o.isMesh && o.geometry?.type === 'SphereGeometry') c.sphere++;
    });
    const targets = new Set(scene.children.filter((o) => o.isDirectionalLight).map((l) => l.target));
    c.orphanTargets = scene.children.filter((o) => targets.has(o)).length - c.dir;
    return c;
  };

  const load = async () => {
    const cfg = await fixture();
    errs.length = 0;
    window.editor.load(cfg);
    return cfg;
  };

  /** Field-by-field diff, so a report names what drifted instead of "not equal". */
  const diff = (a, b, path = '', out = []) => {
    if (a === b) return out;
    const plain = (v) => v && typeof v === 'object';
    if (!plain(a) || !plain(b)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
      return out;
    }
    new Set([...Object.keys(a), ...Object.keys(b)]).forEach((k) => diff(a[k], b[k], path ? `${path}.${k}` : k, out));
    return out;
  };

  /**
   * Loads the fixture and checks it arrived intact. Everything here is an
   * invariant the fixture is built to exercise, so a regression anywhere in
   * save/load shows up as a named FAIL rather than a blank screen.
   */
  const report = async () => {
    const cfg = await load();
    const want = cfg._editorData.sceneObjects;
    const got = storedScene();
    const l = live();
    const ed = window.editor.getCurrentParticleSystemConfig()._editorData;
    const mesh = window.editor.getCurrentParticleSystemConfig().renderer?.mesh;

    const lines = [];
    const check = (label, ok, detail = '') => lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);

    check('scene object count', got.length === want.length, `${got.length}/${want.length}`);
    check('scene data identical', diff(want, got).length === 0, diff(want, got).slice(0, 4).join(' | '));
    check('live boxes', l.box === want.filter((o) => o.type === 'BOX').length, `${l.box}`);
    check('live spheres', l.sphere === want.filter((o) => o.type === 'SPHERE').length, `${l.sphere}`);
    check('live point lights', l.point === want.filter((o) => o.type === 'POINT_LIGHT').length, `${l.point}`);
    check('live probes', l.probe === want.filter((o) => o.type === 'LIGHT_PROBE').length, `${l.probe}`);
    check('no orphaned light targets', l.orphanTargets === 0, `${l.orphanTargets}`);
    check('sceneObjects stripped from live config', !('sceneObjects' in ed));
    check('mesh.lit preserved', mesh?.lit === cfg.renderer?.mesh?.lit, `${mesh?.lit}`);
    check('mesh.emissive preserved', mesh?.emissive === cfg.renderer?.mesh?.emissive, `${mesh?.emissive}`);

    const wantTex = cfg._editorData.colorInstanceTextureId;
    const gotTex = ed.colorInstanceTextureId;
    check('colour texture bound', !!gotTex, `${wantTex} -> ${gotTex}`);

    // Opacity over lifetime is its own section, right under Size, and the
    // gradient editor no longer reaches into it.
    // Top-level sections only: a section's own sub-folders have titles too.
    const titles = [...document.querySelectorAll('.lil-gui.root > .children > .lil-gui > .title')].map((t) => t.textContent.trim());
    const iSize = titles.indexOf('Size over lifetime');
    const iOpacity = titles.indexOf('Opacity over lifetime');
    check('opacity section sits under size', iSize >= 0 && iOpacity === iSize + 1, `${iSize} -> ${iOpacity}`);
    const cfgLive = window.editor.getCurrentParticleSystemConfig();
    const gradientFolder = [...document.querySelectorAll('.lil-gui')].find((g) => g.querySelector(':scope > .title')?.textContent.trim() === 'Color over lifetime (Gradient)');
    const enableBox = gradientFolder?.querySelector('.controller input[type=checkbox]');
    check('gradient editor is colour only', !!gradientFolder && !!enableBox);
    if (enableBox) {
      const opacityBefore = cfgLive.opacityOverLifetime?.isActive;
      const colorBefore = cfgLive.colorOverLifetime?.isActive;
      enableBox.click();
      const colorToggled = cfgLive.colorOverLifetime?.isActive === !colorBefore;
      const opacityUntouched = cfgLive.opacityOverLifetime?.isActive === opacityBefore;
      enableBox.click();
      check('gradient toggle drives colour', colorToggled && cfgLive.colorOverLifetime?.isActive === colorBefore);
      check('gradient toggle leaves opacity alone', opacityUntouched);
    }
    check('no runtime errors', errs.length === 0, errs.slice(0, 3).join(' | '));

    const failed = lines.filter((s) => s.startsWith('FAIL')).length;
    return [`${FIXTURE}: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /**
   * Which top-level objects the output camera can still see. The layer split is
   * the whole point of the preview, so it is checked by asking a layer-0 mask
   * rather than by trusting that every helper remembered to mark itself.
   */
  const layerSplit = () => {
    const scene = window.__world.scene;
    const artworkOnly = new window.__world.THREE.Layers();
    artworkOnly.set(0);
    const seen = [];
    const hidden = [];
    scene.children.forEach((o) => {
      const label = `${o.type}${o.material ? '/' + o.material.type : ''}`;
      (o.layers.test(artworkOnly) ? seen : hidden).push(label);
    });
    return { seen, hidden };
  };

  /** Camera-specific checks, run on top of report()'s fixture load. */
  const cameraReport = () => {
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);

    const split = layerSplit();
    const leaked = split.seen.filter((l) => /Basic|Line|AxesHelper/.test(l));
    check('no editor furniture on the artwork layer', leaked.length === 0, leaked.join(','));
    check('furniture is actually marked', split.hidden.length >= 7, `${split.hidden.length} hidden`);
    check('editor camera sees everything', window.__world.camera.layers.mask === -1 >>> 0 || window.__world.camera.layers.mask === -1);

    const cams = storedScene().filter((o) => o.type === 'CAMERA');
    const active = window.__world.getOutputCamera();
    check('camera count', cams.length > 0, `${cams.length}`);
    if (cams.length) {
      const c = cams[0];
      check('camera has a lens', c.fov > 0 && c.near > 0 && c.far > c.near, `fov ${c.fov} near ${c.near} far ${c.far}`);
      check('camera has an aspect', !!c.aspect, `${(c.aspect || 0).toFixed(3)}`);
      check('camera has a rotation', !!c.rotation, JSON.stringify(c.rotation));
      check('output camera wired to world', !!active, active ? `fov ${active.fov}` : 'null');
      check('output camera only sees artwork', active ? active.layers.mask === 1 : false, active ? String(active.layers.mask) : '-');
      // The grip is drawn with canvas-relative coordinates but clicked with
    // window-relative ones. They differ by the toolbar's height, and when that
    // was unaccounted for the handle rendered in one place and responded in
    // another — invisible in a screenshot, so it gets an assertion.
    const canvas = window.__world.canvasBounds();
    const box = window.__world.previewRect();
    const gripX = box.x + 8;
    const gripY = box.y + box.h - 8;
    check('resize grip reacts where it is drawn', window.__world.overPreviewHandle(gripX, gripY));
    check(
      'grip hit test is in canvas space, not window space',
      canvas.top === 0 || !window.__world.overPreviewHandle(gripX + canvas.left, gripY + canvas.top),
      `canvas offset ${canvas.left},${canvas.top}`
    );
    // Reset Camera exists to rescue a lost view, so it has to land on the scene
    // rather than merely somewhere, and at the agreed three-quarter angle.
    (() => {
      const w = window.__world;
      const restore = { pos: w.camera.position.clone(), target: w.controls.target.clone() };
      w.camera.position.set(-1400, 900, 2200);
      w.controls.target.set(700, -400, -1100);
      w.controls.update();
      window.editor.resetCamera();

      const offset = w.camera.position.clone().sub(w.controls.target);
      const dist = offset.length();
      const elevation = w.THREE.MathUtils.radToDeg(Math.asin(offset.y / dist));
      const azimuth = w.THREE.MathUtils.radToDeg(Math.atan2(offset.x, offset.z));
      check('reset camera lands on the scene', w.controls.target.length() < 3, `target ${w.controls.target.toArray().map((n) => n.toFixed(1))}`);
      check('reset camera uses a 45/45 view', Math.abs(elevation - 45) < 1 && Math.abs(azimuth - 45) < 1, `${elevation.toFixed(0)}deg up, ${azimuth.toFixed(0)}deg around`);
      check('reset camera frames the scene', dist > 5 && dist < 200, `${dist.toFixed(0)} away`);

      w.camera.position.copy(restore.pos);
      w.controls.target.copy(restore.target);
      w.controls.update();
    })();

    check('preview can exceed half the screen', (() => {
      const before = window.__world.getPreviewScale();
      window.__world.setPreviewScale(1);
      const widest = window.__world.previewRect().w;
      window.__world.setPreviewScale(before);
      return widest >= window.innerWidth / 2;
    })());

    // Reflections are a property of the camera, not of the editor session — the
    // whole reason they kept vanishing on reload before.
    const shot = storedScene().find((o) => o.type === 'CAMERA');
    const live = window.__world.getSsrSettings();
    check('camera carries its own SSR settings', !!shot?.ssr, JSON.stringify(shot?.ssr ?? null));
    check('stored SSR settings are complete', shot?.ssr && Object.keys(shot.ssr).length === Object.keys(live).length, `${Object.keys(shot?.ssr ?? {}).length} of ${Object.keys(live).length} keys`);
    // Compared key by key: stringify would also fail on a difference of order,
    // which says nothing about whether the renderer got the right values.
    const sameSettings =
      shot?.ssr && Object.keys(live).every((k) => shot.ssr[k] === live[k]);
    check(
      'renderer uses the camera\'s settings',
      sameSettings,
      sameSettings ? '' : Object.keys(live).filter((k) => shot?.ssr?.[k] !== live[k]).join(',')
    );
    check('fixture ships with reflections on', live.enabled === true);

    const frustums = window.__world.scene.children.filter((o) => o.type === 'CameraHelper');
      check('frustum helper present', frustums.length === cams.length, `${frustums.length}`);
      check(
        'frustum helper kept out of output',
        frustums.every((f) => !f.layers.test((() => { const l = new window.__world.THREE.Layers(); l.set(0); return l; })()))
      );
    }

    const failed = lines.filter((s) => s.startsWith('FAIL')).length;
    return [`camera: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /**
   * Environment checks, run against a panorama generated here rather than the
   * fixture's, so the test scene keeps whatever look it was saved with.
   */
  const environmentReport = async () => {
    const w = window.__world;
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);

    const before = w.getEnvironmentSettings();

    // A 2x1 panorama: blue above, black below. Small, but a real decode.
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 1;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3070ff';
    ctx.fillRect(0, 0, 2, 1);
    const source = c.toDataURL('image/png');

    await w.setEnvironment({ source, format: 'ldr' });
    check('panorama decodes and prefilters', w.hasEnvironmentTexture());
    check('scene receives the environment', !!w.scene.environment);

    // The two visibilities are the point. scene.background cannot be inspected
    // for this — it holds whichever pass ran last — so the decision is queried
    // per view instead.
    await w.setEnvironment({ showInViewport: false, showInCamera: false });
    check('lighting survives both backdrops hidden', !!w.scene.environment);
    check('no backdrop anywhere when both are off', !w.backdropFor('viewport').isTexture && !w.backdropFor('camera').isTexture);

    await w.setEnvironment({ showInViewport: true, showInCamera: false });
    check('viewport shows it while the camera does not', w.backdropFor('viewport').isTexture === true && !w.backdropFor('camera').isTexture);
    check('hiding the backdrop leaves the lighting alone', !!w.scene.environment);

    await w.setEnvironment({ showInViewport: false, showInCamera: true });
    check('camera shows it while the viewport does not', w.backdropFor('camera').isTexture === true && !w.backdropFor('viewport').isTexture);

    await w.setEnvironment({ intensity: 2.5 });
    check('intensity reaches the scene', w.scene.environmentIntensity === 2.5);
    await w.setEnvironment({ rotation: 90 });
    check('rotation reaches the scene', Math.abs(w.scene.environmentRotation.y - Math.PI / 2) < 1e-6);

    await w.setEnvironment({ source: null });
    check('clearing the panorama releases it', !w.hasEnvironmentTexture());

    await w.setEnvironment(before);
    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`environment: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /** Frame checks, on a frame built here rather than one saved in the fixture. */
  const frameReport = async () => {
    const w = window.__world;
    const T = w.THREE;
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);

    const build = async (patch) => {
      const cfg = await fixture();
      // The fixture has a frame of its own now, and scene order would hand back
      // that one instead of the probe. Measure a scene with exactly one frame.
      cfg._editorData.sceneObjects = cfg._editorData.sceneObjects.filter((o) => o.type !== 'FRAME');
      cfg._editorData.sceneObjects.push({
        id: 'obj-frame-probe', type: 'FRAME', name: 'Frame probe', visible: true,
        position: { x: 0, y: 2, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
        innerWidth: 6, innerHeight: 3.5, border: 0.6, depth: 0.5,
        color: '#d8d8d8', roughness: 0.6, metalness: 0.2,
        edgeColor: '#ffffff', edgeRoughness: 0.25, edgeMetalness: 0.9,
        ...patch,
      });
      window.editor.load(cfg);
      await new Promise((r) => setTimeout(r, 700));
      const mesh = w.scene.children.find((o) => o.isMesh && Array.isArray(o.material));
      const size = new T.Box3().setFromObject(mesh).getSize(new T.Vector3());
      return { mesh, size };
    };

    const base = await build({});
    check('frame builds one mesh with two material slots', base.mesh?.material?.length === 2);
    check('geometry groups match the slots', base.mesh?.geometry.groups.length === 2);
    // Outer size is the opening plus the surround on both sides: the whole point
    // of measuring a frame this way rather than by its outside.
    check('outer size is opening plus surround', Math.abs(base.size.x - 7.2) < 0.01 && Math.abs(base.size.y - 4.7) < 0.01, `${base.size.x.toFixed(2)}x${base.size.y.toFixed(2)}`);
    check('depth is honoured', Math.abs(base.size.z - 0.5) < 0.01, base.size.z.toFixed(2));
    check('face and edge materials are distinct', base.mesh.material[0].roughness !== base.mesh.material[1].roughness);

    const wider = await build({ innerWidth: 12 });
    check('opening drives the geometry', Math.abs(wider.size.x - 13.2) < 0.01, wider.size.x.toFixed(2));
    const thicker = await build({ border: 2 });
    check('surround drives the geometry', Math.abs(thicker.size.x - 10) < 0.01, thicker.size.x.toFixed(2));
    const deeper = await build({ depth: 3 });
    check('depth drives the geometry', Math.abs(deeper.size.z - 3) < 0.01, deeper.size.z.toFixed(2));

    await load();
    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`frame: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };


  /**
   * The link to the display window, exercised from this side of it.
   *
   * The display is a separate page with its own renderer, so what can be
   * checked from here is the contract rather than the picture: that the editor
   * answers a display announcing itself, that what it sends survives a
   * structured clone — the live config carries the entries' own recreate
   * callbacks, and posting one of those is exactly how this broke the first
   * time — and that a panorama is not re-cloned onto the wire on every push.
   */
  const playerReport = async () => {
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);

    const channel = new BroadcastChannel('three-particles-player');
    const inbox = [];
    channel.onmessage = (event) => inbox.push(event.data);

    /** A channel never receives its own posts, so everything here is the editor's. */
    const waitFor = async (type, ms = 4000) => {
      const start = performance.now();
      while (performance.now() - start < ms) {
        const found = inbox.filter((m) => m?.type === type).pop();
        if (found) return found;
        await new Promise((r) => setTimeout(r, 40));
      }
      return null;
    };

    // A tiny 2x1 PNG standing in for a panorama: large enough to be a real
    // source string, small enough to read back in an assertion.
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 1;
    canvas.getContext('2d').fillStyle = '#3070ff';
    canvas.getContext('2d').fillRect(0, 0, 2, 1);
    const panorama = canvas.toDataURL('image/png');

    const withEnvironment = async (extra) => {
      const cfg = await fixture();
      cfg._editorData.sceneObjects = cfg._editorData.sceneObjects.filter(
        (o) => o.type !== 'ENVIRONMENT'
      );
      cfg._editorData.sceneObjects.push({
        id: 'obj-env-probe',
        type: 'ENVIRONMENT',
        name: 'Panorama probe',
        visible: false,
        position: { x: 0, y: 0, z: 0 },
        environment: { source: panorama, format: 'ldr', intensity: 1, rotation: 0, blur: 0, showInViewport: false, showInCamera: false },
      });
      Object.assign(cfg._editorData.sceneObjects.find((o) => o.type === 'SPHERE'), extra);
      window.editor.load(cfg);
    };

    // ── The handshake ────────────────────────────────────────────────────────
    channel.postMessage({ type: 'hello' });
    // A live display keeps saying so; without this the editor would drop the
    // link partway through the checks below, as it should for a dead one.
    const pinger = setInterval(() => channel.postMessage({ type: 'ping' }), 2000);
    const snapshot = await waitFor('snapshot');
    check('editor answers a display that announces itself', !!snapshot);

    if (snapshot) {
      const data = snapshot.config?._editorData ?? {};
      check('snapshot carries the scene', Array.isArray(data.sceneObjects), `${data.sceneObjects?.length ?? 0} objects`);
      check('snapshot carries the emitter', typeof snapshot.config?.duration === 'number' || !!snapshot.config?.emission);
      // Uploaded textures live in localStorage, which the display shares.
      check('snapshot leaves texture payloads at home', data.embeddedTextures === undefined);
      // The emitter's canned motion is config, not scene, so it rides in
      // _editorData — and the display runs it from the same numbers.
      check(
        'snapshot carries the emitter simulation',
        typeof data.simulation?.movements === 'string' && typeof data.simulation?.movementSpeed === 'number',
        `${data.simulation?.movements} @ ${data.simulation?.movementSpeed}`
      );

      // The editor also leaves its latest piece in storage, for a display that
      // cannot reach a live editor — a phone freezes the tab it came from.
      const stored = JSON.parse(localStorage.getItem('particle-system-editor/player-snapshot') || 'null');
      check('a stored snapshot accompanies the live one', !!stored?.config && typeof stored.savedAt === 'number', stored ? `saved ${Date.now() - stored.savedAt}ms ago` : 'none');
      check('the stored snapshot is the same piece', stored?.config?._editorData?.metadata?.name === snapshot.config?._editorData?.metadata?.name, `${stored?.config?._editorData?.metadata?.name}`);
      check('the stored snapshot leaves the scene to scene-objects', stored?.config?._editorData?.sceneObjects === undefined);
      check('the stored snapshot leaves texture payloads at home', stored?.config?._editorData?.embeddedTextures === undefined);

      // The clone already happened — a function anywhere in here would have
      // thrown DataCloneError instead of arriving — but naming it makes the
      // failure legible rather than a silent absence.
      const functions = [];
      const walk = (node, path, seen) => {
        if (!node || typeof node !== 'object' || seen.has(node)) return;
        seen.add(node);
        Object.keys(node).forEach((key) => {
          const value = node[key];
          if (typeof value === 'function') functions.push(`${path}.${key}`);
          else if (value && typeof value === 'object') walk(value, `${path}.${key}`, seen);
        });
      };
      walk(snapshot.config, 'config', new Set());
      check('nothing on the wire is a function', functions.length === 0, functions.join(', '));
    }

    // ── Incremental pushes ───────────────────────────────────────────────────
    inbox.length = 0;
    await withEnvironment({ position: { x: 1.5, y: 1.5, z: 0 } });
    const first = await waitFor('scene');
    check('a scene change reaches the display', !!first);
    const firstEnv = first?.objects?.find((o) => o.type === 'ENVIRONMENT');
    check('a panorama the display has not seen travels in full', firstEnv?.environment?.source === panorama);

    // An emitter change refreshes the stored copy too, live display or not.
    const storedBefore = JSON.parse(localStorage.getItem('particle-system-editor/player-snapshot') || 'null')?.savedAt ?? 0;
    inbox.length = 0;
    await withEnvironment({ position: { x: -1.5, y: 1.5, z: 0 } });
    const second = await waitFor('scene');
    await new Promise((r) => setTimeout(r, 300));
    const storedAfter = JSON.parse(localStorage.getItem('particle-system-editor/player-snapshot') || 'null')?.savedAt ?? 0;
    check('an emitter change refreshes the stored snapshot', storedAfter > storedBefore, `${storedAfter - storedBefore}ms later`);
    const secondEnv = second?.objects?.find((o) => o.type === 'ENVIRONMENT');
    check('the next push moves the object', second?.objects?.find((o) => o.type === 'SPHERE')?.position.x === -1.5);
    check(
      'an unchanged panorama travels as a sentinel',
      typeof secondEnv?.environment?.source === 'string' &&
        secondEnv.environment.source !== panorama &&
        secondEnv.environment.source.length < 64,
      `${secondEnv?.environment?.source?.length ?? 0} chars vs ${panorama.length}`
    );

    // ── The button ───────────────────────────────────────────────────────────
    const button = document.querySelector('.player-window-toggle');
    check('the toggle button exists', !!button);
    if (button && window.__world?.getOutputCamera()) {
      const box = button.getBoundingClientRect();
      const canvasBox = window.__world.canvasBounds();
      const preview = window.__world.previewRect();
      check('the button sits outside the preview, not on it', box.right <= canvasBox.left + preview.x);
      check('the button lines up with the preview top', Math.abs(box.top - (canvasBox.top + preview.y)) <= 1, `${Math.round(box.top)} vs ${Math.round(canvasBox.top + preview.y)}`);
    }

    // ── Suspension ───────────────────────────────────────────────────────────
    //
    // `linked` is true from the hello above, so the focus input alone decides.
    // This page can never lose focus for real, which is why the editor exposes
    // an override for it.
    const link = window.__playerLink;
    check('the editor exposes its suspension rule', typeof link?.shouldSuspendEditor === 'function');

    if (link) {
      check('no display, no suspension', link.shouldSuspendEditor(false, false) === false);
      check('display open, editor focused — keeps drawing', link.shouldSuspendEditor(true, true) === false);
      check('display open, editor blurred — suspends', link.shouldSuspendEditor(true, false) === true);

      const card = document.querySelector('.player-suspend-card');
      const canvas = window.__world.renderer.domElement;
      check('the pause card exists', !!card);

      /** Frames are irregular in an automated pane, so this waits rather than counts. */
      const drewAFrame = async (ms) => {
        const start = link.frames();
        const t0 = performance.now();
        while (performance.now() - t0 < ms) {
          if (link.frames() > start) return true;
          await new Promise((r) => setTimeout(r, 40));
        }
        return false;
      };

      link.setFocusOverride(true);
      check('a focused editor keeps drawing beside the display', await drewAFrame(3000));
      check('no card while the editor is drawing', card?.style.display === 'none');
      check('the viewport is at full strength while drawing', canvas.style.filter === '');

      link.setFocusOverride(false);
      // One frame for the loop to notice, then the loop must go quiet.
      await new Promise((r) => setTimeout(r, 200));
      check('the loop applied the suspension', link.isSuspended() === true);
      check('a blurred editor stops drawing', (await drewAFrame(600)) === false);
      check('the card says so', card?.style.display === 'flex');
      check('the frozen viewport is dimmed', canvas.style.filter.includes('brightness'));

      if (card) {
        const z = Number(getComputedStyle(card).zIndex);
        const buttonZ = Number(getComputedStyle(document.querySelector('.player-window-toggle')).zIndex);
        // A suspended editor is a control surface, not a modal: nothing may
        // cover the panels, and the card must not outrank them either.
        check('the card sits under the panels', z < 10, `z ${z}`);
        check('the toggle button stays above the card', buttonZ > z, `${buttonZ} vs ${z}`);
        check('nothing covers the panels', !document.querySelector('.player-suspend-overlay'));
        // lil-gui is the half of the editor that still works while suspended.
        const gui = document.querySelector('.lil-gui');
        check('the control panel is untouched', !gui || getComputedStyle(gui).filter === 'none');
        check('the card itself is clickable', getComputedStyle(card).pointerEvents === 'auto');
      }

      const editorStats = document.querySelector('.stats');
      check('the frozen counter is dimmed', editorStats?.style.opacity === '0.25');

      link.setFocusOverride(true);
      check('focus brings the editor back', await drewAFrame(3000));
      check('and takes the card away', card?.style.display === 'none');
      check('and the dim with it', canvas.style.filter === '');
      check('and the counter with it', editorStats?.style.opacity === '');

      // A display that goes silent — killed without its bye — must not leave
      // the editor suspended. Stop answering and wait past the timeout.
      clearInterval(pinger);
      link.setFocusOverride(false);
      await new Promise((r) => setTimeout(r, 6500));
      check('a display that fell silent releases the editor', link.isSuspended() === false);
      link.setFocusOverride(null);
    }

    clearInterval(pinger);
    // Stop the editor pushing at a display that was never really there.
    channel.postMessage({ type: 'bye' });
    channel.close();
    await load();

    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`player: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /**
   * A video as the colour source, end to end: stored the way an upload is,
   * playing on a loop, read back by the library as frames arrive, and gone
   * without a trace afterwards.
   *
   * The readback assertions need frames: emission happens inside the render
   * loop, and rVFC only fires in a visible document. In an automated pane the
   * frame-dependent lines can fail for that reason alone — they say so.
   */
  const videoReport = async () => {
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (pred, ms) => {
      const start = performance.now();
      while (performance.now() - start < ms) {
        if (pred()) return true;
        await settle(50);
      }
      return !!pred();
    };
    const VIDEO_URL = './assets-local/AnimateDiff_00013.mp4';

    const api = window.__videoTextures;
    check('editor exposes the video registry', !!api);
    if (!api) return ['video: 0/1 passed', ...lines].join('\n');

    // Leftovers from an interrupted run would otherwise pile up in IndexedDB.
    for (const stale of api.entries().filter((e) => e.url === VIDEO_URL || e.size === 73618914)) {
      await api.remove(stale.id);
    }

    const response = await fetch(VIDEO_URL);
    check('test video is served', response.ok, `HTTP ${response.status}`);
    if (!response.ok) return [`video: ${lines.length - 1}/${lines.length} passed`, ...lines].join('\n');
    const blob = await response.blob();

    // ── The upload path, minus the file dialog ────────────────────────────
    const t0 = performance.now();
    let entry = null;
    try {
      entry = await api.addFile(new File([blob], 'AnimateDiff_00013.mp4', { type: 'video/mp4' }));
    } catch (error) {
      check('upload stores and decodes', false, String(error));
    }
    if (entry) {
      check('upload stores and decodes', entry.width === 2048 && entry.height === 2048, `${entry.width}x${entry.height} in ${Math.round(performance.now() - t0)}ms`);
      check('duration is known', entry.duration > 47 && entry.duration < 48, `${entry.duration?.toFixed(2)}s`);
      check('entry persisted in the list', api.entries().some((e) => e.id === entry.id));
      check('thumbnail captured', typeof entry.thumbnail === 'string' && entry.thumbnail.startsWith('data:image/webp'), `${entry.thumbnail?.length ?? 0} chars`);
      check('the list stays small (bytes are not in localStorage)', (localStorage.getItem('particle-system-editor/video-textures') || '').length < 64 * 1024);
      const stored = await new Promise((resolve) => {
        const open = indexedDB.open('three-particles-editor');
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          const db = open.result;
          try {
            const get = db.transaction('videos').objectStore('videos').get(entry.name);
            get.onsuccess = () => { resolve(get.result); db.close(); };
            get.onerror = () => { resolve(null); db.close(); };
          } catch { resolve(null); }
        };
      });
      check('bytes are in IndexedDB', stored instanceof Blob && stored.size === blob.size, `${stored?.size ?? 0} bytes`);
    }

    const tex = entry && api.get(entry.name);
    const video = tex?.video;
    check('registered under its name with a video-backed map', !!tex?.map && tex.map.image instanceof HTMLVideoElement);
    if (video) {
      check('video loops', video.loop === true);
      check('video is muted (autoplay-safe)', video.muted === true);
      check('video element is in the document and renderable', video.isConnected && getComputedStyle(video).display !== 'none');
      check('video is playing', await waitFor(() => !video.paused && video.readyState >= 2, 3000), `paused ${video.paused}, readyState ${video.readyState}`);
    }

    // ── As the colour source ──────────────────────────────────────────────
    if (entry && tex) {
      window.editor.setColorInstanceTexture(entry.name);
      const cfg = window.editor.getCurrentParticleSystemConfig();
      check('config points at the video by name', cfg._editorData.colorInstanceTextureId === entry.name);
      check('particleColorInstance is on with the video map', cfg.particleColorInstance?.isActive === true && cfg.particleColorInstance.map === tex.map);

      const statsOf = () => tex.map.userData.colorInstanceReadback;
      const first = await waitFor(() => (statsOf()?.count ?? 0) > 0, 4000);
      check('first frame read back on emission (needs frames)', first, JSON.stringify(statsOf() ?? null));
      if (first) {
        const st = statsOf();
        check('readback grid is bounded to 512', st.width <= 512 && st.height <= 512, `${st.width}x${st.height}`);
        check('frames are being watched', st.live === true);
        const before = st.count;
        const more = await waitFor(() => statsOf().count > before + 3, 3000);
        check('readbacks follow the video, not the render loop (needs a visible window)', more, `${statsOf().count - before} more in ≤3s`);
        check('a readback per video frame, not per spawn', statsOf().count < 400, `${statsOf().count} total`);
        // After the first frame the reading leaves the main thread. What the
        // main thread still pays is wrapping the frame and posting it.
        const after = statsOf();
        check('reading moved off the main thread', after.mode === 'worker', `mode ${after.mode}`);
        check('the hand-over is cheap on the main thread', after.mode === 'worker' && after.lastMs < 2, `${after.lastMs.toFixed(2)}ms`);
        check('the worker reports its own time', after.mode !== 'worker' || after.workerMs > 0, `${after.workerMs.toFixed(2)}ms in the worker`);
      }

      cfg.particleColorInstance.sampleSize = 256;
      window.editor.reset();
      const resized = await waitFor(() => statsOf()?.width === 256, 3000);
      check('sample size lever reaches the grid (needs frames)', resized, `${statsOf()?.width ?? 0}`);
      cfg.particleColorInstance.sampleSize = 0;

      if (video && video.duration) {
        video.currentTime = Math.max(0, video.duration - 0.3);
        const wrapped = await waitFor(() => video.currentTime < 1 && !video.paused, 3000);
        check('loops back to the start (needs playback)', wrapped, `t=${video.currentTime.toFixed(2)} paused=${video.paused}`);
      }

      // The wire: the name travels, the bytes do not.
      const wire = JSON.stringify(window.__playerLink ? cfg._editorData : {});
      check('nothing video-sized in the editor data', wire.length < 1024 * 1024, `${wire.length} chars`);
    }

    // ── Cleanup ───────────────────────────────────────────────────────────
    if (entry) {
      await api.remove(entry.id);
      check('removal unregisters the name', !api.get(entry.name));
      check('removal drops the list entry', !api.entries().some((e) => e.id === entry.id));
      check('removal detaches the element', !video || !video.isConnected);
    }
    await load();
    check('no runtime errors', errs.length === 0, errs.slice(0, 3).join(' | '));

    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`video: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /**
   * The drag gizmo, exercised the way a hand would: select an object from the
   * Scene panel, hover its handle, drag it, and expect it to have moved.
   *
   * The handles sit on the furniture layer so the output camera never sees
   * them; the first time that was done, TransformControls' own raycaster —
   * which looks at layer 0 like every raycaster — stopped finding them, and
   * every handle in the editor could be shown but not moved. Pointer events
   * here are synthetic but real DOM events on the canvas, which is exactly
   * what TransformControls listens to.
   */
  const gizmoReport = async () => {
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const w = window.__world;
    const T = w.THREE;

    /** Frames are irregular in an automated pane, so wait for them rather than count. */
    const frames = async (n, ms = 3000) => {
      const link = window.__playerLink;
      const start = link.frames();
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        if (link.frames() >= start + n) return true;
        await settle(30);
      }
      return false;
    };

    await load();
    // The handle has to be in view to be hovered, and the editor camera is
    // wherever the session left it. Frame the scene, and put it back after.
    const cameraBefore = { pos: w.camera.position.clone(), target: w.controls.target.clone() };
    window.editor.resetCamera();
    await frames(2);

    // Select the sphere from the panel, like a user would.
    const previousTab = [...document.querySelectorAll('[role=tab]')].find((t) => t.getAttribute('aria-selected') === 'true');
    const sceneTab = [...document.querySelectorAll('[role=tab]')].find((t) => /scene/i.test(t.textContent));
    sceneTab?.click();
    await settle(300);
    const item = [...document.querySelectorAll('.item')].find((el) => /sphere/i.test(el.querySelector('.title')?.textContent || ''));
    const selectButton = item?.querySelector('button[title="Show drag axes in the viewport"]');
    check('the Scene panel offers a handle toggle for the sphere', !!selectButton);
    selectButton?.click();
    await frames(2);

    const root = w.scene.children.find((o) => o.isTransformControlsRoot);
    const controls = root?.controls;
    check('selecting attaches the gizmo', !!controls?.object, controls?.object?.type ?? 'nothing attached');

    if (controls?.object) {
      // Layer contract: drawn only for the editor, but findable by its own raycaster.
      const artwork = new T.Layers();
      artwork.set(0);
      const leaks = [];
      root.traverse((o) => { if (o.layers.test(artwork)) leaks.push(o.type); });
      check('gizmo stays off the artwork layer', leaks.length === 0, leaks.slice(0, 3).join(','));
      check('gizmo raycaster can see the furniture layer', controls.getRaycaster().layers.test(root.layers));

      const canvas = w.renderer.domElement;
      // A real pointermove reports button -1; TransformControls ignores moves
      // that claim a button, so the synthetic ones have to say the same.
      const fire = (type, x, y) =>
        canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerType: 'mouse', pointerId: 1, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, isPrimary: true, bubbles: true, cancelable: true }));
      const clientOf = (v) => {
        const p = v.clone().project(w.camera);
        const b = w.canvasBounds();
        return [b.left + ((p.x + 1) / 2) * b.width, b.top + ((1 - p.y) / 2) * b.height];
      };
      const origin = controls.object.getWorldPosition(new T.Vector3());
      const [cx, cy] = clientOf(origin);
      const b = w.canvasBounds();
      check('the selected object is on screen', cx > b.left && cx < b.right && cy > b.top && cy < b.bottom, `${Math.round(cx)},${Math.round(cy)}`);

      // Hover a spiral around the centre until a handle lights up.
      let hit = null;
      for (let r = 0; r <= 80 && !hit; r += 4) {
        for (let a = 0; a < 360 && !hit; a += 30) {
          const x = cx + r * Math.cos((a * Math.PI) / 180);
          const y = cy + r * Math.sin((a * Math.PI) / 180);
          fire('pointermove', x, y);
          if (controls.axis) hit = { x, y, axis: controls.axis };
        }
      }
      check('hovering a handle highlights an axis', !!hit, hit ? `${hit.axis} at ${Math.round(hit.x - cx)},${Math.round(hit.y - cy)}` : 'nothing within 80px');

      if (hit) {
        const before = controls.object.position.clone();
        const stored = () => storedScene().find((o) => o.type === 'SPHERE')?.position;
        const storedBefore = JSON.stringify(stored());
        fire('pointerdown', hit.x, hit.y);
        check('pressing a handle starts a drag', controls.dragging === true);
        fire('pointermove', hit.x + 40, hit.y + 25);
        fire('pointermove', hit.x + 80, hit.y + 50);
        const during = controls.object.position.clone();
        fire('pointerup', hit.x + 80, hit.y + 50);
        const moved = during.distanceTo(before);
        check('dragging moves the object', moved > 0.05, `${moved.toFixed(3)} units`);
        check('the drag ends on release', controls.dragging === false);
        check('the stored scene follows the drag', JSON.stringify(stored()) !== storedBefore);
        check('orbit controls are back after the drag', w.controls.enabled === true);
      }
    }

    previousTab?.click();
    await load();
    w.camera.position.copy(cameraBefore.pos);
    w.controls.target.copy(cameraBefore.target);
    w.controls.update();
    check('no runtime errors', errs.length === 0, errs.slice(0, 3).join(' | '));
    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`gizmo: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  /**
   * Presentation mode: this window as the display. Entered from the button
   * under the player toggle, checked for what it promises — panels gone, the
   * canvas the camera's shape, the frame still advancing, the output going
   * through the encode once — and left again by Escape.
   */
  const presentReport = async () => {
    const lines = [];
    const check = (label, ok, detail = '') =>
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const w = window.__world;
    const link = window.__playerLink;
    const frames = async (n, ms = 3000) => {
      const start = link.frames();
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        if (link.frames() >= start + n) return true;
        await settle(30);
      }
      return false;
    };

    await load();
    await frames(2);

    const toggle = document.querySelector('.player-window-toggle');
    const present = document.querySelector('.presentation-toggle');
    check('the presentation button exists', !!present);
    if (toggle && present) {
      const a = toggle.getBoundingClientRect();
      const b = present.getBoundingClientRect();
      check('it sits directly under the player toggle', Math.abs(a.left - b.left) < 1 && b.top > a.bottom && b.top - a.bottom < 12, `${Math.round(b.top - a.bottom)}px below`);
    }

    const cam = w.getOutputCamera();
    const canvas = w.renderer.domElement;
    const sizeBefore = [canvas.clientWidth, canvas.clientHeight];

    present?.click();
    await frames(2);

    check('body is marked presenting', document.body.classList.contains('presenting'));
    // Not rendered at all — its own display or an ancestor's; computed style
    // on the element alone would miss the ancestor case.
    const hidden = (el) => !el || el.getClientRects().length === 0;
    check('the control panel is hidden', hidden(document.querySelector('.lil-gui.root')));
    check('the left panel is hidden', hidden(document.querySelector('.wrapper .wrapper')));
    check('the toolbar is hidden', hidden(document.querySelector('body > .wrapper:not(:has(#three-particles-editor))')));
    check('the player buttons are hidden', hidden(toggle) && hidden(present));
    check('the frame counter stays', !hidden(document.querySelector('.stats')));

    // The canvas takes the camera's shape inside the window, like the player.
    const aspect = cam?.aspect || 16 / 9;
    let ew = window.innerWidth, eh = Math.round(ew / aspect);
    if (eh > window.innerHeight) { eh = window.innerHeight; ew = Math.round(eh * aspect); }
    check('the canvas is letterboxed to the camera', Math.abs(canvas.clientWidth - ew) <= 1 && Math.abs(canvas.clientHeight - eh) <= 1, `${canvas.clientWidth}x${canvas.clientHeight} vs ${ew}x${eh}`);
    const box = canvas.getBoundingClientRect();
    check('and centred in the window', Math.abs(box.left + box.width / 2 - window.innerWidth / 2) <= 1 && Math.abs(box.top + box.height / 2 - window.innerHeight / 2) <= 1);

    check('the output goes through the encode once', w._ssr().postProcessing?.outputColorTransform === true);
    check('frames keep coming', await frames(3));
    check('the editor is not suspended while presenting', link.isSuspended() === false);
    check('orbit controls are off', w.controls.enabled === false);

    // A tap brings up the way out. Down then up, like a real finger: the
    // controls on the canvas capture the pointer on the way down and release
    // it on the way up, and an up on its own makes that release throw.
    // The mouse pointer (id 1) is the one pointer a synthetic event can name
    // that the browser considers active; a made-up touch id makes the canvas
    // controls' pointer capture throw, which a real finger never does.
    const tap = (type) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: 10, clientY: 10 }));
    tap('pointerdown');
    tap('pointerup');
    await settle(50);
    const bar = document.querySelector('.presentation-bar');
    check('a tap shows the exit bar', !!bar && bar.classList.contains('is-visible'));

    // The performance HUD rides on the bar: numbers, and levers that work.
    const perfButton = bar?.querySelector('.presentation-bar__perf');
    check('the bar offers the performance HUD', !!perfButton);
    const hud = window.__perfHud;
    perfButton?.click();
    await settle(700);
    check('the HUD is shown', !!hud && hud.isShown() && !!document.querySelector('.perf-hud') && !document.querySelector('.perf-hud').hidden);
    const text = hud ? hud.report() : '';
    check('the report names the piece and the pixels', /piece: WIP-Test/.test(text) && /pixels: \d+×\d+/.test(text) && /^fps: /m.test(text));
    const beforeScale = w.renderer.getPixelRatio();
    const css = [canvas.clientWidth, canvas.clientHeight];
    w.setRenderScale(1);
    await frames(1);
    const buffer = w.renderer.getDrawingBufferSize(new w.THREE.Vector2());
    check('the scale lever changes the drawing buffer', Math.abs(buffer.x - css[0]) <= 1 && Math.abs(buffer.y - css[1]) <= 1, `${buffer.x}x${buffer.y} at scale 1 for ${css[0]}x${css[1]} css`);
    w.setRenderScale(beforeScale >= (window.devicePixelRatio || 1) ? Infinity : beforeScale);
    await frames(1);
    check('and back', Math.abs(w.renderer.getPixelRatio() - beforeScale) < 1e-6);
    hud?.hide();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await frames(2);
    check('Escape leaves presentation', !document.body.classList.contains('presenting'));
    check('the canvas is back to the window', Math.abs(canvas.clientWidth - sizeBefore[0]) <= 1 && Math.abs(canvas.clientHeight - sizeBefore[1]) <= 1, `${canvas.clientWidth}x${canvas.clientHeight}`);
    check('the encode goes back to the blit', w._ssr().postProcessing?.outputColorTransform === false);
    check('orbit controls are back', w.controls.enabled === true);
    check('the buttons are back', !hidden(document.querySelector('.presentation-toggle')));

    // ── Fit window: the frame takes the window's shape, so no bars ──────────
    const previousTab = [...document.querySelectorAll('[role=tab]')].find((t) => t.getAttribute('aria-selected') === 'true');
    [...document.querySelectorAll('[role=tab]')].find((t) => /scene/i.test(t.textContent))?.click();
    await settle(300);
    const cameraItem = [...document.querySelectorAll('.item')].find((el) => /camera/i.test(el.querySelector('.title')?.textContent || ''));
    const chipsOf = () => [...(cameraItem?.querySelectorAll('.chips button') ?? [])];
    if (cameraItem && chipsOf().length === 0) cameraItem.querySelector('button.title')?.click();
    await settle(200);
    const labels = chipsOf().map((b) => b.textContent.trim());
    check('the frame offers an iPhone 17 Pro Max preset', labels.includes('iPhone 17 Pro Max'), labels.join(' | '));
    const fitChip = chipsOf().find((b) => b.textContent.trim() === 'Fit window');
    check('the frame offers Fit window', !!fitChip);
    fitChip?.click();
    await frames(2);
    const windowAspect = window.innerWidth / window.innerHeight;
    check('fit window sets the camera to the window\'s aspect', Math.abs((w.getOutputCamera()?.aspect ?? 0) - windowAspect) < 1e-3, `${w.getOutputCamera()?.aspect.toFixed(3)} vs ${windowAspect.toFixed(3)}`);
    document.querySelector('.presentation-toggle')?.click();
    await frames(2);
    check('presenting with fit window fills the window', Math.abs(canvas.clientWidth - window.innerWidth) <= 1 && Math.abs(canvas.clientHeight - window.innerHeight) <= 1, `${canvas.clientWidth}x${canvas.clientHeight} in ${window.innerWidth}x${window.innerHeight}`);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await frames(2);
    previousTab?.click();
    await load();
    check('no runtime errors', errs.length === 0, errs.slice(0, 3).join(' | '));

    const failed = lines.filter((l) => l.startsWith('FAIL')).length;
    return [`present: ${lines.length - failed}/${lines.length} passed`, ...lines].join('\n');
  };

  window.__t = {
    presentReport,
    gizmoReport,
    videoReport,
    playerReport,
    frameReport,
    environmentReport,
    fixture,
    storedScene,
    live,
    load,
    diff,
    report,
    layerSplit,
    cameraReport,
    errs,
  };
  return 'harness ready: await __t.report() | __t.cameraReport() | await __t.videoReport() | await __t.gizmoReport() | await __t.load() | __t.errs';
})();
