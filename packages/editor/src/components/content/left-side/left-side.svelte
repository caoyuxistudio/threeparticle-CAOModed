<script lang="ts">
  import { Icon } from '@smui/common';
  import Examples from '../examples/examples.svelte';
  import Library from '../library/library.svelte';
  import Textures from '../textures/textures.svelte';
  import { onMount } from 'svelte';

  const STORAGE_KEY = 'leftPanelCollapsed';

  const tabs = [
    {
      icon: 'settings_suggest',
      label: 'Examples',
    },
    {
      icon: 'collections',
      label: 'Library',
    },
    {
      icon: 'texture',
      label: 'Texture',
    },
  ].map((entry, index) => ({ ...entry, index }));
  let active = $state(tabs[0]);

  // Panel state - exported to allow binding from parent components
  let { isCollapsed = $bindable(false) }: { isCollapsed?: boolean } = $props();

  // Load saved state on component mount
  onMount(() => {
    try {
      const savedState = localStorage.getItem(STORAGE_KEY);
      if (savedState !== null) {
        isCollapsed = savedState === 'true';
      }
    } catch (error) {
      console.error('Failed to load panel state from localStorage:', error);
    }
  });

  // Toggle panel collapsed state and save to localStorage
  const togglePanel = (): void => {
    isCollapsed = !isCollapsed;
    saveState();
  };

  // Save panel state to localStorage
  const saveState = (): void => {
    try {
      localStorage.setItem(STORAGE_KEY, isCollapsed.toString());
    } catch (error) {
      console.error('Failed to save panel state to localStorage:', error);
    }
  };
</script>

<div class="wrapper" class:collapsed={isCollapsed}>
  <!-- Full panel content - visible when expanded -->
  <div class="panel-content">
    <!-- Plain tab row instead of SMUI TabBar: three tabs exceeded the 310px
         panel width and turned it into a clipped, hard-to-click scroller. -->
    <div class="tab-row" role="tablist">
      {#each tabs as tab (tab.index)}
        <button
          type="button"
          role="tab"
          class="tab-button"
          class:active={active.index === tab.index}
          aria-selected={active.index === tab.index}
          onclick={() => (active = tab)}
        >
          <Icon class="material-icons">{tab.icon}</Icon>
          <span class="tab-label">{tab.label}</span>
        </button>
      {/each}
    </div>

    {#if active.index === 0}
      <Examples />
    {:else if active.index === 1}
      <Library />
    {:else if active.index === 2}
      <Textures />
    {/if}
  </div>

  <!-- Collapsed panel with tab icons only -->
  <div class="collapsed-tabs">
    {#each tabs as tab (tab.index)}
      <button
        type="button"
        class="collapsed-tab-icon"
        class:active={active.index === tab.index}
        aria-label={tab.label}
        onclick={() => {
          active = tab;
          isCollapsed = false;
          saveState();
        }}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            active = tab;
            isCollapsed = false;
            saveState();
          }
        }}
      >
        <Icon class="material-icons">{tab.icon}</Icon>
      </button>
    {/each}
  </div>

  <!-- Toggle button at the bottom -->
  <button
    type="button"
    class="collapse-toggle"
    onclick={togglePanel}
    aria-label={isCollapsed ? 'Expand panel' : 'Collapse panel'}
  >
    <span class="material-icons">
      {isCollapsed ? 'chevron_right' : 'chevron_left'}
    </span>
  </button>
</div>

<style lang="scss">
  .wrapper {
    position: absolute;
    left: 0;
    top: 0;
    width: 310px;
    height: 100%;
    max-height: 100%;
    background-color: var(--mdc-theme-background);
    border-right: 1px solid var(--border);
    display: flex;
    transition: width 0.3s ease;
    overflow: visible;
    z-index: 100;

    &.collapsed {
      width: 40px;

      .panel-content {
        opacity: 0;
        pointer-events: none;
      }

      .collapsed-tabs {
        opacity: 1;
        pointer-events: auto;
      }
    }

    .panel-content {
      width: 100%;
      height: 100%;
      opacity: 1;
      transition: opacity 0.2s ease;
    }

    .tab-row {
      display: flex;
      width: 100%;
      border-bottom: 1px solid var(--border);

      .tab-button {
        flex: 1 1 0;
        min-width: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        height: 48px;
        padding: 0 2px;
        background: transparent;
        border: none;
        border-bottom: 2px solid transparent;
        color: inherit;
        opacity: 0.7;
        cursor: pointer;
        font-family: inherit;
        font-size: 11px;
        font-weight: 500;
        letter-spacing: 0.3px;
        text-transform: uppercase;
        outline: none;

        .tab-label {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        :global(.material-icons) {
          font-size: 16px;
          /* The icon font is loaded from Google Fonts; if it is unavailable the
             ligature falls back to its literal name and would blow up the tab
             width, so keep it clipped to the glyph box. */
          width: 18px;
          overflow: hidden;
          flex: 0 0 auto;
        }

        &:hover,
        &:focus-visible {
          opacity: 1;
          background-color: rgba(255, 255, 255, 0.06);
        }

        &.active {
          opacity: 1;
          color: var(--mdc-theme-primary);
          border-bottom-color: var(--mdc-theme-primary);
        }
      }
    }

    .collapsed-tabs {
      position: absolute;
      top: 10px;
      left: 0;
      width: 40px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 5px 0;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;

      .collapsed-tab-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 30px;
        cursor: pointer;
        background: transparent;
        border: none;
        padding: 3px 8px;
        color: inherit;
        outline: none;

        &:hover,
        &:focus {
          background-color: rgba(255, 255, 255, 0.1);
        }

        &:focus-visible {
          outline: 1px solid var(--mdc-theme-primary);
        }

        &.active {
          color: var(--mdc-theme-primary);
        }
      }
    }

    .collapse-toggle {
      position: absolute;
      bottom: 10px;
      z-index: 10;
      background-color: var(--mdc-theme-background);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      width: 30px;
      height: 30px;
      padding: 0;
      outline: none;
      color: inherit;
      transition:
        right 0.3s ease,
        border-radius 0.3s ease,
        border 0.3s ease;

      /* Expanded state - outside the panel */
      right: -30px;
      border-radius: 0 4px 4px 0;
      border: 1px solid var(--border);
      border-left: none;

      .collapsed & {
        /* Collapsed state - inside the panel */
        right: 5px;
        border-radius: 4px;
        border: 1px solid var(--border);
      }

      .material-icons {
        font-size: 22px;
      }

      &:hover,
      &:focus {
        background-color: rgba(255, 255, 255, 0.1);
      }

      &:focus-visible {
        outline: 1px solid var(--mdc-theme-primary);
      }
    }
  }
</style>
