<script>
  import Button, { Label, Icon } from '@smui/button';
  import { shrinkImageDataUrl } from '../../../js/utils/image-utils';
  import { showErrorSnackbar } from '../../../js/stores/snackbar-store';

  let { add } = $props();

  let fileinput;

  const toBase64 = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result);
      reader.onerror = (error) => reject(error);
    });

  const onFileSelected = async (e) => {
    const image = e.target.files[0];
    if (!image) return;
    try {
      const dataUrl = await toBase64(image);
      // Bound the stored size — camera-sized images blow past the localStorage
      // quota on their own and the upload would not survive a reload.
      add(await shrinkImageDataUrl(dataUrl));
    } catch (error) {
      showErrorSnackbar('Failed to read the image file');
    } finally {
      // Allow re-selecting the same file after a failure.
      e.target.value = '';
    }
  };
</script>

<div class="add-image">
  <Button
    color="secondary"
    onclick={() => {
      fileinput.click();
    }}
    variant="outlined"
  >
    <Icon class="material-icons">image_search</Icon><Label>Add Image</Label>
  </Button>
</div>
<input
  style="display:none"
  type="file"
  accept=".jpg, .jpeg, .png, .webp"
  onchange={(e) => onFileSelected(e)}
  bind:this={fileinput}
/>

<style lang="scss">
  .add-image {
    width: 100%;
    padding: 0 16px;
  }

  * :global(.mdc-button) {
    width: 100%;
  }
</style>
