<script>
  import { Icon } from '@smui/common';
  import * as THREE from 'three';
  import {
    getCamera,
    defaultSsrSettings,
    defaultEnvironmentSettings,
    setOnEnvironmentLoaded,
  } from './../../../js/three-particles-editor/world';
  import { onMount } from 'svelte';

  let { obj, update, remove, bake, selected = false, select, contextMenu } = $props();

  let open = $state(false);
  let baking = $state(false);

  const set = (patch) => update(obj.id, patch);

  /**
   * Reflection settings live on the camera, so they patch like anything else —
   * but always onto a complete set. Storing only the keys that were touched
   * would leave the rest reading from whatever the defaults happen to be later,
   * so an old camera's look would drift when those change.
   */
  const setSsr = (patch) =>
    set({ ssr: { ...defaultSsrSettings(), ...(obj.ssr ?? {}), ...patch } });

  const SSR_VIEWS = [
    { id: 'off', label: 'Final image' },
    { id: 'reflection', label: 'Reflections only' },
    { id: 'color', label: 'Colour buffer' },
    { id: 'normal', label: 'Normals' },
    { id: 'metalness', label: 'Metalness' },
    { id: 'roughness', label: 'Roughness' },
    { id: 'depth', label: 'Depth' },
  ];

  /** Snaps this camera onto the viewport's current position and lens. */
  const alignToView = () => {
    const view = getCamera();
    const euler = new THREE.Euler().setFromQuaternion(view.quaternion, 'XYZ');
    set({
      position: { x: view.position.x, y: view.position.y, z: view.position.z },
      rotation: {
        x: THREE.MathUtils.radToDeg(euler.x),
        y: THREE.MathUtils.radToDeg(euler.y),
        z: THREE.MathUtils.radToDeg(euler.z),
      },
      fov: view.fov,
    });
  };
  const setVec = (key, axis, value) => set({ [key]: { ...obj[key], [axis]: value } });

  const runBake = async () => {
    baking = true;
    try {
      await bake(obj.id);
    } finally {
      baking = false;
    }
  };

  const ICON = {
    BOX: 'view_in_ar',
    SPHERE: 'circle',
    POINT_LIGHT: 'lightbulb',
    DIRECTIONAL_LIGHT: 'wb_sunny',
    LIGHT_PROBE: 'blur_on',
    CAMERA: 'photo_camera',
    ENVIRONMENT: 'panorama_photosphere',
  };

  let envFileInput;
  let envStatus = $state('');

  onMount(() => {
    setOnEnvironmentLoaded((error) => (envStatus = error ? `Could not read that file: ${error}` : ''));
    return () => setOnEnvironmentLoaded(null);
  });

  const setEnv = (patch) =>
    set({ environment: { ...defaultEnvironmentSettings(), ...(obj.environment ?? {}), ...patch } });

  /** Radiance and OpenEXR are not image formats the browser can decode. */
  const formatOf = (name) => {
    const ext = name.split('.').pop().toLowerCase();
    if (ext === 'exr') return 'exr';
    if (ext === 'hdr' || ext === 'pic') return 'hdr';
    return 'ldr';
  };

  const readAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const onEnvFile = async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    envStatus = 'Reading…';
    try {
      const source = await readAsDataUrl(file);
      // High dynamic range panoramas are routinely tens of megabytes, well past
      // what localStorage holds. Loading one still works for the session; it is
      // only the saving that cannot, and saying so beats a silent loss.
      const megabytes = source.length / (1024 * 1024);
      setEnv({ source, format: formatOf(file.name), name: file.name });
      envStatus =
        megabytes > 4
          ? `${file.name} — ${megabytes.toFixed(1)}MB, too large to save; reload will clear it`
          : '';
    } catch {
      envStatus = 'Could not read that file';
    }
  };

  /** Common output shapes, so an installation's frame is one click away. */
  const ASPECTS = [
    { label: '16:9', value: 16 / 9 },
    { label: '4:3', value: 4 / 3 },
    { label: '1:1', value: 1 },
    { label: '9:16', value: 9 / 16 },
    { label: '2:1', value: 2 },
  ];
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="item"
  class:hidden={!obj.visible}
  class:selected
  oncontextmenu={(e) => {
    e.preventDefault();
    contextMenu?.(obj.id, e.clientX, e.clientY);
  }}
>
  <div class="head">
    <button class="eye" title="Show / hide" onclick={() => set({ visible: !obj.visible })}>
      <Icon class="material-icons">{obj.visible ? 'visibility' : 'visibility_off'}</Icon>
    </button>
    {#if obj.type !== 'LIGHT_PROBE' && obj.type !== 'ENVIRONMENT'}
      <button
        class="pick"
        title={selected ? 'Hide drag axes' : 'Show drag axes in the viewport'}
        onclick={() => select(obj.id)}
      >
        <Icon class="material-icons">{selected ? 'gps_fixed' : 'gps_not_fixed'}</Icon>
      </button>
    {/if}
    <button class="title" onclick={() => (open = !open)}>
      <Icon class="material-icons type">{ICON[obj.type]}</Icon>
      <span class="name">{obj.name}</span>
      <Icon class="material-icons chevron">{open ? 'expand_less' : 'expand_more'}</Icon>
    </button>
    <button class="del" title="Delete" onclick={() => remove(obj.id)}>
      <Icon class="material-icons">delete</Icon>
    </button>
  </div>

  {#if open}
    <div class="body">
      {#if obj.type !== 'ENVIRONMENT'}
        <div class="group-label">position</div>
        {#each ['x', 'y', 'z'] as axis}
          <label class="row">
            <span>{axis}</span>
            <input type="range" min="-20" max="20" step="0.05"
              value={obj.position[axis]}
              oninput={(e) => setVec('position', axis, +e.target.value)} />
            <input type="number" step="0.05"
              value={obj.position[axis]}
              oninput={(e) => setVec('position', axis, +e.target.value)} />
          </label>
        {/each}
      {/if}


      {#if obj.type === 'ENVIRONMENT'}
        <button class="wide" onclick={() => envFileInput.click()}>
          {obj.environment?.name ? 'Replace panorama' : 'Load panorama'}
        </button>
        <input
          style="display:none"
          type="file"
          accept=".jpg,.jpeg,.png,.webp,.hdr,.exr"
          bind:this={envFileInput}
          onchange={onEnvFile} />
        <p class="hint">
          {obj.environment?.name || 'Equirectangular JPEG, PNG, WebP, Radiance HDR or OpenEXR.'}
        </p>
        {#if envStatus}
          <p class="hint warn">{envStatus}</p>
        {/if}

        <div class="group-label">lighting</div>
        <label class="row">
          <span>intensity</span>
          <input type="range" min="0" max="5" step="0.05"
            value={obj.environment?.intensity ?? 1}
            oninput={(e) => setEnv({ intensity: +e.target.value })} />
          <input type="number" step="0.05"
            value={obj.environment?.intensity ?? 1}
            oninput={(e) => setEnv({ intensity: +e.target.value })} />
        </label>
        <label class="row">
          <span>rotation</span>
          <input type="range" min="0" max="360" step="1"
            value={obj.environment?.rotation ?? 0}
            oninput={(e) => setEnv({ rotation: +e.target.value })} />
          <input type="number" step="1"
            value={obj.environment?.rotation ?? 0}
            oninput={(e) => setEnv({ rotation: +e.target.value })} />
        </label>
        <label class="row">
          <span>blur</span>
          <input type="range" min="0" max="1" step="0.01"
            value={obj.environment?.blur ?? 0}
            oninput={(e) => setEnv({ blur: +e.target.value })} />
          <input type="number" step="0.01"
            value={obj.environment?.blur ?? 0}
            oninput={(e) => setEnv({ blur: +e.target.value })} />
        </label>

        <div class="group-label">show backdrop in</div>
        <label class="row check">
          <span>viewport</span>
          <input type="checkbox"
            checked={obj.environment?.showInViewport ?? true}
            onchange={(e) => setEnv({ showInViewport: e.target.checked })} />
        </label>
        <label class="row check">
          <span>camera</span>
          <input type="checkbox"
            checked={obj.environment?.showInCamera ?? true}
            onchange={(e) => setEnv({ showInCamera: e.target.checked })} />
        </label>
        <p class="hint">
          These hide the panorama from view only. It keeps lighting the scene and
          showing up in reflections either way — which is how you get the light
          without the backdrop.
        </p>
      {/if}

      {#if obj.type === 'BOX' || obj.type === 'SPHERE' || obj.type === 'CAMERA'}
        <div class="group-label">rotation (deg)</div>
        {#each ['x', 'y', 'z'] as axis}
          <label class="row">
            <span>{axis}</span>
            <input type="range" min="-180" max="180" step="1"
              value={obj.rotation?.[axis] ?? 0}
              oninput={(e) => setVec('rotation', axis, +e.target.value)} />
            <input type="number" step="1"
              value={obj.rotation?.[axis] ?? 0}
              oninput={(e) => setVec('rotation', axis, +e.target.value)} />
          </label>
        {/each}
      {/if}

      {#if obj.type === 'CAMERA'}
        <div class="group-label">lens</div>
        <label class="row">
          <span>fov</span>
          <input type="range" min="10" max="120" step="1" value={obj.fov ?? 45}
            oninput={(e) => set({ fov: +e.target.value })} />
          <input type="number" step="1" value={obj.fov ?? 45}
            oninput={(e) => set({ fov: +e.target.value })} />
        </label>
        <label class="row">
          <span>near</span>
          <input type="range" min="0.01" max="5" step="0.01" value={obj.near ?? 0.1}
            oninput={(e) => set({ near: +e.target.value })} />
          <input type="number" step="0.01" value={obj.near ?? 0.1}
            oninput={(e) => set({ near: +e.target.value })} />
        </label>
        <label class="row">
          <span>far</span>
          <input type="range" min="10" max="500" step="1" value={obj.far ?? 200}
            oninput={(e) => set({ far: +e.target.value })} />
          <input type="number" step="1" value={obj.far ?? 200}
            oninput={(e) => set({ far: +e.target.value })} />
        </label>

        <div class="group-label">output frame</div>
        <div class="chips">
          {#each ASPECTS as a}
            <button
              class:active={Math.abs((obj.aspect ?? 16 / 9) - a.value) < 0.001}
              onclick={() => set({ aspect: a.value })}>{a.label}</button>
          {/each}
        </div>

        <button class="wide" onclick={alignToView}>
          Align to current view
        </button>

        <div class="group-label">reflections (SSR)</div>
        <label class="row check">
          <span>enabled</span>
          <input
            type="checkbox"
            checked={obj.ssr?.enabled ?? false}
            onchange={(e) => setSsr({ enabled: e.target.checked })} />
        </label>

        {#if obj.ssr?.enabled}
          {#each [
            { key: 'maxDistance', label: 'distance', min: 1, max: 60, step: 0.5, fallback: 20 },
            { key: 'opacity', label: 'strength', min: 0, max: 1, step: 0.01, fallback: 1 },
            { key: 'quality', label: 'quality', min: 0.1, max: 1, step: 0.05, fallback: 1 },
            { key: 'thickness', label: 'thickness', min: 0.01, max: 1, step: 0.01, fallback: 0.15 },
            { key: 'blurQuality', label: 'blur', min: 0, max: 3, step: 1, fallback: 2 },
          ] as p}
            <label class="row">
              <span>{p.label}</span>
              <input type="range" min={p.min} max={p.max} step={p.step}
                value={obj.ssr?.[p.key] ?? p.fallback}
                oninput={(e) => setSsr({ [p.key]: +e.target.value })} />
              <input type="number" step={p.step}
                value={obj.ssr?.[p.key] ?? p.fallback}
                oninput={(e) => setSsr({ [p.key]: +e.target.value })} />
            </label>
          {/each}

          <label class="row">
            <span>view</span>
            <select
              value={obj.ssr?.debug ?? 'off'}
              onchange={(e) => setSsr({ debug: e.target.value })}>
              {#each SSR_VIEWS as v}
                <option value={v.id}>{v.label}</option>
              {/each}
            </select>
          </label>
          <p class="hint">
            Only surfaces with metalness above zero reflect, and only what is
            already on screen can appear in them. If a wall stays blank, check
            it in the Metalness view first.
          </p>
        {/if}

        <p class="hint">
          The corner preview renders through the first visible camera. Hide this
          one to preview another. Drag the grip in its bottom-left corner to
          resize it.
        </p>
      {/if}

      {#if obj.type === 'BOX' || obj.type === 'SPHERE'}
        <div class="group-label">size</div>
        {#each ['x', 'y', 'z'] as axis}
          <label class="row">
            <span>{axis}</span>
            <input type="range" min="0.05" max="30" step="0.05"
              value={obj.size[axis]}
              oninput={(e) => setVec('size', axis, +e.target.value)} />
            <input type="number" step="0.05"
              value={obj.size[axis]}
              oninput={(e) => setVec('size', axis, +e.target.value)} />
          </label>
        {/each}

        <div class="group-label">material</div>
        <label class="row">
          <span>color</span>
          <input type="color" value={obj.color}
            oninput={(e) => set({ color: e.target.value })} />
        </label>
        <label class="row">
          <span>rough</span>
          <input type="range" min="0" max="1" step="0.01" value={obj.roughness}
            oninput={(e) => set({ roughness: +e.target.value })} />
          <input type="number" step="0.01" value={obj.roughness}
            oninput={(e) => set({ roughness: +e.target.value })} />
        </label>
        <label class="row">
          <span>metal</span>
          <input type="range" min="0" max="1" step="0.01" value={obj.metalness}
            oninput={(e) => set({ metalness: +e.target.value })} />
          <input type="number" step="0.01" value={obj.metalness}
            oninput={(e) => set({ metalness: +e.target.value })} />
        </label>
        <label class="row">
          <span>emis</span>
          <input type="color" value={obj.emissive}
            oninput={(e) => set({ emissive: e.target.value })} />
          <input type="number" step="0.1" min="0" value={obj.emissiveIntensity}
            oninput={(e) => set({ emissiveIntensity: +e.target.value })} />
        </label>
        <label class="row check">
          <input type="checkbox" checked={obj.insideOut}
            onchange={(e) => set({ insideOut: e.target.checked })} />
          <span>inside out (room)</span>
        </label>
      {/if}

      {#if obj.type === 'POINT_LIGHT' || obj.type === 'DIRECTIONAL_LIGHT'}
        <div class="group-label">light</div>
        <label class="row">
          <span>color</span>
          <input type="color" value={obj.color}
            oninput={(e) => set({ color: e.target.value })} />
        </label>
        <label class="row">
          <span>power</span>
          <input type="range" min="0" max={obj.type === 'POINT_LIGHT' ? 400 : 20} step="0.5"
            value={obj.intensity}
            oninput={(e) => set({ intensity: +e.target.value })} />
          <input type="number" step="0.5" value={obj.intensity}
            oninput={(e) => set({ intensity: +e.target.value })} />
        </label>
        {#if obj.type === 'DIRECTIONAL_LIGHT'}
          <div class="group-label">aims at</div>
          {#each ['x', 'y', 'z'] as axis}
            <label class="row">
              <span>{axis}</span>
              <input type="range" min="-20" max="20" step="0.1"
                value={obj.target?.[axis] ?? 0}
                oninput={(e) => setVec('target', axis, +e.target.value)} />
              <input type="number" step="0.1"
                value={obj.target?.[axis] ?? 0}
                oninput={(e) => setVec('target', axis, +e.target.value)} />
            </label>
          {/each}
          <div class="hint">
            A directional light points from its position to this target;
            rotating it has no effect.
          </div>
        {/if}
        {#if obj.type === 'POINT_LIGHT'}
          <label class="row">
            <span>decay</span>
            <input type="range" min="0" max="4" step="0.1" value={obj.decay}
              oninput={(e) => set({ decay: +e.target.value })} />
            <input type="number" step="0.1" value={obj.decay}
              oninput={(e) => set({ decay: +e.target.value })} />
          </label>
        {/if}
      {/if}

      {#if obj.type === 'LIGHT_PROBE'}
        <div class="group-label">probe</div>
        <label class="row">
          <span>power</span>
          <input type="range" min="0" max="6" step="0.05" value={obj.intensity}
            oninput={(e) => set({ intensity: +e.target.value })} />
          <input type="number" step="0.05" value={obj.intensity}
            oninput={(e) => set({ intensity: +e.target.value })} />
        </label>
        <label class="row">
          <span>cap. h</span>
          <input type="range" min="0" max="15" step="0.1" value={obj.captureHeight}
            oninput={(e) => set({ captureHeight: +e.target.value })} />
          <input type="number" step="0.1" value={obj.captureHeight}
            oninput={(e) => set({ captureHeight: +e.target.value })} />
        </label>
        <label class="row check">
          <input type="checkbox" checked={obj.includeParticles}
            onchange={(e) => set({ includeParticles: e.target.checked })} />
          <span>include particles</span>
        </label>
        <button class="bake" onclick={runBake} disabled={baking}>
          {baking ? 'Baking…' : 'Bake environment'}
        </button>
        <div class="hint">
          A probe is a single average of the surroundings — it has no notion of
          position or occlusion, so it tints every surface equally. Re-bake after
          changing lights, colours or the emitter.
        </div>
      {/if}
    </div>
  {/if}
</div>

<style lang="scss">
  .item {
    border: 1px solid var(--border);
    border-radius: 4px;
    margin: 8px 12px;
    background: rgba(255, 255, 255, 0.02);

    &.hidden { opacity: 0.45; }
    &.selected { border-color: var(--mdc-theme-primary, #ff5722); }
  }

  .head {
    display: flex;
    align-items: center;

    button {
      background: none;
      border: none;
      color: inherit;
      cursor: pointer;
      padding: 8px 6px;
      display: flex;
      align-items: center;
      font: inherit;
    }

    .title {
      flex: 1;
      gap: 6px;
      min-width: 0;
      .name { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
    }

    :global(.material-icons) { font-size: 17px; }
    :global(.type) { opacity: 0.75; }
    :global(.chevron) { opacity: 0.5; }
    .del:hover { color: #ff6b6b; }
    .pick { opacity: 0.7; &:hover { opacity: 1; } }
  }

  .body {
    padding: 4px 10px 12px;
    border-top: 1px solid var(--border);
  }

  .group-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    opacity: 0.5;
    margin: 10px 0 4px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;

    span { width: 42px; font-size: 11px; opacity: 0.75; }
    input[type='range'] { flex: 1; min-width: 0; }
    input[type='number'] {
      width: 58px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border);
      border-radius: 3px;
      color: inherit;
      font-size: 11px;
      padding: 2px 4px;
    }
    input[type='color'] {
      width: 34px; height: 22px; padding: 0;
      background: none; border: 1px solid var(--border); border-radius: 3px;
    }
    &.check { span { width: auto; } }
  }

  .bake {
    width: 100%;
    margin-top: 8px;
    padding: 6px;
    background: var(--mdc-theme-primary, #ff5722);
    color: #fff;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;

    &:disabled { opacity: 0.6; cursor: default; }
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 2px 0 4px;

    button {
      flex: 1 1 auto;
      padding: 4px 0;
      background: #2a2a2a;
      color: #999;
      border: 1px solid #3a3a3a;
      border-radius: 3px;
      cursor: pointer;
      font: inherit;
      font-size: 10px;

      &.active {
        border-color: var(--mdc-theme-primary, #ff5722);
        color: #eee;
      }
    }
  }

  select {
    flex: 1;
    min-width: 0;
    padding: 2px 4px;
    background: #2a2a2a;
    color: #ddd;
    border: 1px solid #3a3a3a;
    border-radius: 3px;
    font: inherit;
    font-size: 11px;
  }

  .wide {
    width: 100%;
    margin-top: 8px;
    padding: 6px;
    background: #2a2a2a;
    color: #ddd;
    border: 1px solid #3a3a3a;
    border-radius: 3px;
    cursor: pointer;
    font: inherit;
    font-size: 11px;

    &:hover { border-color: var(--mdc-theme-primary, #ff5722); }
  }

  .hint.warn {
    color: #e0955f;
    opacity: 0.95;
  }

  .hint {
    margin-top: 8px;
    font-size: 10px;
    line-height: 1.5;
    opacity: 0.55;
  }
</style>
