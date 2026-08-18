<script>
  import { Svroller } from 'svrollbar';
  import { particleExamples } from '../../../examples-config';
  import { readSavedConfigs } from '../../../js/utils/saved-configs';
  import { Input } from '@smui/textfield';
  import Paper from '@smui/paper';
  import { Icon } from '@smui/common';

  import Example from './example.svelte';

  // Configs saved from the SAVE / SAVE AS buttons live in localStorage and were
  // previously reachable only through the LOAD dialog. They are listed here,
  // above the built-in examples, so saved work shows up where it is looked for.
  const loadMine = () =>
    readSavedConfigs()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((entry) => ({
        key: entry.id,
        name: entry.name,
        config: JSON.stringify(entry.config),
        preview: './assets/images/transparent.webp',
      }));

  let savedConfigs = $state(loadMine());
  let filter = $state('');

  // Re-read on mount of the tab and whenever another tab/window writes a save.
  $effect(() => {
    const refresh = () => (savedConfigs = loadMine());
    window.addEventListener('storage', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('focus', refresh);
    };
  });

  const matches = (name, config) =>
    name.toLowerCase().includes(filter.toLowerCase()) ||
    (config && config.toLowerCase().includes(filter.toLowerCase()));

  const filteredSaved = $derived(savedConfigs.filter(({ name }) => matches(name, null)));
  const filteredExamples = $derived(
    particleExamples.filter(({ name, config }) => matches(name, config))
  );
</script>

<div>
  <Paper class="solo-paper" elevation={6}>
    <Icon class="material-icons">search</Icon>
    <Input bind:value={filter} placeholder="Search" class="solo-input" />
  </Paper>
</div>
<Svroller width="100%" height="calc(100% - 70px)">
  {#if filteredSaved.length > 0}
    <div class="section-title">My saved configs</div>
    {#each filteredSaved as example (example.key)}
      <Example name={example.name} config={example.config} preview={example.preview} />
    {/each}
    <div class="section-title">Examples</div>
  {/if}
  {#each filteredExamples as example (example.name)}
    <Example {...example} />
  {/each}
</Svroller>

<style lang="scss">
  .section-title {
    padding: 8px 16px 0;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.6px;
    text-transform: uppercase;
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
