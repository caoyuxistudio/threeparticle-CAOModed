<script>
  import Button, { Label, Icon } from '@smui/button';

  /**
   * Hands the chosen file straight to `add`: a video is stored as a blob, not
   * read into memory as a string, so there is nothing to convert here.
   *
   * `addUrl` takes an address instead. A URL video is the kind a config can
   * carry with it (embeddedVideos), so it is how a piece meant for another
   * device — a phone, the wall — should reference its video.
   */
  let { add, addUrl = null } = $props();

  const askForUrl = () => {
    // eslint-disable-next-line no-alert
    const url = window.prompt(
      'Video URL (same site, or a host that allows cross-origin use):',
      './assets/videos/'
    );
    if (url && url.trim()) addUrl?.(url.trim());
  };

  let fileinput;

  const onFileSelected = (e) => {
    const file = e.target.files[0];
    if (file) add(file);
    // Allow re-selecting the same file after a failure.
    e.target.value = '';
  };
</script>

<div class="add-video">
  <Button
    color="secondary"
    onclick={() => {
      fileinput.click();
    }}
    variant="outlined"
  >
    <Icon class="material-icons">movie</Icon><Label>Add Video</Label>
  </Button>
  {#if addUrl}
    <Button color="secondary" onclick={askForUrl} variant="text">
      <Icon class="material-icons">link</Icon><Label>Add Video by URL</Label>
    </Button>
  {/if}
</div>
<input
  style="display:none"
  type="file"
  accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v"
  onchange={(e) => onFileSelected(e)}
  bind:this={fileinput}
/>

<style lang="scss">
  .add-video {
    width: 100%;
    padding: 8px 16px 0;
  }

  * :global(.mdc-button) {
    width: 100%;
  }
</style>
