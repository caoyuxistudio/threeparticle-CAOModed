<script>
  import Button, { Label, Icon } from '@smui/button';

  /**
   * Hands the chosen file straight to `add`: a video is stored as a blob, not
   * read into memory as a string, so there is nothing to convert here.
   */
  let { add } = $props();

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
