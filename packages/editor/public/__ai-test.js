/**
 * Throwaway verification harness. Not part of the app, not committed
 * (public/__ai-* is gitignored). Nothing imports it; it is fetched and eval'd
 * from the console after a reload:
 *
 *   await fetch('/__ai-test.js').then(r=>r.text()).then(eval); __t.report()
 *
 * It exists so a change can be checked in two tool calls instead of twenty
 * clicks and screenshots.
 */
(() => {
  const FIXTURE = 'ForAITEST';
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
  const EXAMPLE_URL = './examples/foraitest/config.json';
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

  window.__t = {
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
  return 'harness ready: await __t.report() | __t.cameraReport() | await __t.load() | __t.errs';
})();
