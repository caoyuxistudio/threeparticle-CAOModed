import { getTexture } from '../assets';
import { openTextureSelectorModal } from '../texture-selector/texture-selector';

type ParticleColorInstanceEntriesParams = {
  parentFolder: any;
  particleSystemConfig: any;
  recreateParticleSystem: () => void;
};

type ParticleColorInstanceEntriesResult = {
  onReset: () => void;
  onAssetUpdate: () => void;
};

/**
 * "Particle Color Instance" — maps an image onto the emitter's X/Z plane so
 * every particle samples its start color from the pixel under its spawn
 * position. The texture id is persisted in _editorData.colorInstanceTextureId
 * (the THREE.Texture itself is not serializable).
 */
export const createParticleColorInstanceEntries = ({
  parentFolder,
  particleSystemConfig,
  recreateParticleSystem,
}: ParticleColorInstanceEntriesParams): ParticleColorInstanceEntriesResult => {
  const folder = parentFolder.addFolder('Particle Color Instance');
  folder.close();

  if (!particleSystemConfig.particleColorInstance) {
    particleSystemConfig.particleColorInstance = {
      isActive: false,
      area: { x: 0, z: 0 },
      useAlphaForOpacity: false,
    };
  }
  const config = particleSystemConfig.particleColorInstance;
  if (!config.area) config.area = { x: 0, z: 0 };
  if (config.useLuminanceForNoise === undefined) config.useLuminanceForNoise = false;
  if (config.luminanceNoiseAmount === undefined) config.luminanceNoiseAmount = 0;

  const applyTexture = (textureId: string | undefined): void => {
    const texture = textureId ? getTexture(textureId) : null;
    config.map = texture ? texture.map : undefined;
  };

  const displayConfig = {
    selectedTexture: particleSystemConfig._editorData.colorInstanceTextureId || 'None',
  };

  folder.add(config, 'isActive').onChange(recreateParticleSystem).listen();

  folder.add(displayConfig, 'selectedTexture').name('Selected Image').listen().disable();

  folder
    .add(
      {
        selectImage: () => {
          openTextureSelectorModal({
            currentTextureId: particleSystemConfig._editorData.colorInstanceTextureId,
            onSelect: (textureId: string) => {
              particleSystemConfig._editorData.colorInstanceTextureId = textureId;
              displayConfig.selectedTexture = textureId;
              applyTexture(textureId);
              recreateParticleSystem();
            },
          });
        },
      },
      'selectImage'
    )
    .name('Choose Image...');

  const areaFolder = folder.addFolder('area (0 = auto from shape)');
  areaFolder
    .add(config.area, 'x', 0, 100, 0.1)
    .onChange(recreateParticleSystem)
    .listen();
  areaFolder
    .add(config.area, 'z', 0, 100, 0.1)
    .onChange(recreateParticleSystem)
    .listen();

  folder
    .add(config, 'useAlphaForOpacity')
    .onChange(recreateParticleSystem)
    .listen();

  // Drives curl-noise strength from the sampled pixel's brightness.
  folder
    .add(config, 'useLuminanceForNoise')
    .name('luminance -> curl noise')
    .onChange(recreateParticleSystem)
    .listen();

  folder
    .add(config, 'luminanceNoiseAmount', -1, 1, 0.01)
    .name('luminance amount')
    .onChange(recreateParticleSystem)
    .listen();

  // Re-inject the non-serializable texture after a config load/reset. The
  // particle system was already (re)created from the raw JSON by then — without
  // the map — so when the section is active, recreate it with the map applied.
  const onReset = (): void => {
    const textureId = particleSystemConfig._editorData.colorInstanceTextureId;
    displayConfig.selectedTexture = textureId || 'None';
    applyTexture(textureId);
    if (config.isActive && config.map) {
      recreateParticleSystem();
    }
  };
  onReset();

  // Sync the display when the texture is changed from outside this panel
  // (e.g. the Texture tab's "Use" button) — the map is already applied there.
  const onAssetUpdate = (): void => {
    displayConfig.selectedTexture =
      particleSystemConfig._editorData.colorInstanceTextureId || 'None';
  };

  return { onReset, onAssetUpdate };
};
