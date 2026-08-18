<script>
  import { loadCustomAssets } from './../../../js/three-particles-editor/assets';
  import { textureConfigs } from './../../../js/three-particles-editor/texture-config';
  import FileUploader from './../library/file-uploader.svelte';
  import { Svroller } from 'svrollbar';
  import { Input } from '@smui/textfield';
  import Paper from '@smui/paper';
  import { Icon } from '@smui/common';
  import TextureItem from './texture-item.svelte';
  import { showErrorSnackbar } from './../../../js/stores/snackbar-store';

  const STORAGE_KEY = 'particle-system-editor/image-textures';

  let rawList = $state(JSON.parse(localStorage.getItem(STORAGE_KEY)) || []);
  let filter = $state('');
  let currentTextureId = $state(getCurrentId());

  function getCurrentId() {
    return window.editor?.getCurrentParticleSystemConfig()._editorData.colorInstanceTextureId;
  }

  const filtered = $derived(
    rawList.filter(({ name }) => name.toLowerCase().includes(filter.toLowerCase()))
  );

  // Returns false when the write was rejected (quota) so callers can roll back
  // instead of showing an entry that will be gone after a reload.
  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rawList));
      return true;
    } catch (error) {
      showErrorSnackbar(
        'Not enough browser storage left — delete some textures and try again.'
      );
      return false;
    }
  };

  const add = (url) => {
    const randomId = Math.floor(Math.random() * 100000000);
    const entry = {
      url,
      name: `ImageTexture-${Math.floor(Math.random() * 1000)}`,
      id: randomId,
    };
    rawList.unshift(entry);
    // Persist immediately: the entry must survive even if the image cannot be
    // decoded into a GPU texture, otherwise it shows in the list but is gone
    // after a reload.
    if (!save()) {
      rawList.shift();
      return;
    }
    loadCustomAssets({
      textures: [{ id: entry.name, url }],
      onComplete: () => {},
    });
  };

  const remove = (id) => {
    const entry = rawList.find(({ id: currentId }) => currentId === id);
    if (entry) {
      const idx = textureConfigs.findIndex(({ id: cfgId }) => cfgId === entry.name);
      if (idx >= 0) textureConfigs.splice(idx, 1);
      if (getCurrentId() === entry.name) {
        window.editor.setColorInstanceTexture(undefined);
        currentTextureId = undefined;
      }
    }
    rawList = rawList.filter(({ id: currentId }) => currentId !== id);
    save();
  };

  const rename = ({ id, name }) => {
    const currentEntry = rawList.find((entry) => entry.id === id);
    if (currentEntry && currentEntry.name !== name) {
      textureConfigs.forEach(
        (entry) => (entry.id = entry.id === currentEntry.name ? name : entry.id)
      );
      if (getCurrentId() === currentEntry.name) {
        window.editor.getCurrentParticleSystemConfig()._editorData.colorInstanceTextureId = name;
        currentTextureId = name;
      }
      currentEntry.name = name;
      save();
    }
  };

  const use = (id) => {
    const entry = rawList.find(({ id: currentId }) => currentId === id);
    if (!entry) return;
    window.editor.setColorInstanceTexture(entry.name);
    currentTextureId = entry.name;
  };
</script>

<div class="head">
  <Paper class="solo-paper" elevation={6}>
    <Icon class="material-icons">search</Icon>
    <Input bind:value={filter} placeholder="Search" class="solo-input" />
  </Paper>
  <FileUploader {add} />
  <div class="current">
    Instance texture: <b>{currentTextureId || 'None'}</b>
  </div>
</div>
<Svroller width="100%" height="calc(100% - 120px)">
  {#each filtered as item (item.id)}
    <TextureItem {...item} {remove} {rename} {use} inUse={item.name === currentTextureId} />
  {/each}
  {#if filtered.length === 0}
    <div class="empty">No image textures yet — click "Add Image" to upload one.</div>
  {/if}
</Svroller>

<style lang="scss">
  .head {
    margin-bottom: 8px;
  }

  .current {
    padding: 8px 16px 0;
    font-size: 12px;
    opacity: 0.8;
  }

  .empty {
    padding: 24px 16px;
    font-size: 13px;
    opacity: 0.6;
  }

  * :global(.solo-paper) {
    display: flex;
    align-items: center;
    flex-grow: 1;
    max-width: 600px;
    padding: 0 12px;
    height: 48px;
    margin: 16px;
  }
  * :global(.solo-paper > *) {
    display: inline-block;
    margin: 0 12px;
  }
  * :global(.solo-input) {
    flex-grow: 1;
    color: var(--mdc-theme-on-surface, #000);
  }
  * :global(.solo-input::placeholder) {
    color: var(--mdc-theme-on-surface, #000);
    opacity: 0.6;
  }
</style>
