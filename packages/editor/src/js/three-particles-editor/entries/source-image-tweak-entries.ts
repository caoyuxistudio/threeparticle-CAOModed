type SourceImageTweakEntriesParams = {
  parentFolder: any;
  particleSystemConfig: any;
  recreateParticleSystem: () => void;
};

type SourceImageTweakEntriesResult = {
  onReset: () => void;
};

const defaultColorTweak = () => ({ saturation: 1, contrast: 1, hue: 0 });
const defaultLuminanceMap = () => ({ black: 0, white: 1 });

/**
 * "Source Image Tweak" — the look of the colour source, sitting right under
 * Particle Color Instance, which picks the source. Two separate levers on the
 * same sampled pixel:
 *
 * - Colour source: saturation, level (contrast) and hue, applied to the pixel
 *   before it becomes the particle's start colour (library: colorTweak).
 * - Luminosity noise map: which luminance counts as black and which as white
 *   when the pixel's brightness drives the curl noise (library: luminanceMap).
 *   Measured on the pixel as sampled, so changing the look does not change the
 *   motion.
 *
 * Both live in particleColorInstance and travel with the config.
 */
export const createSourceImageTweakEntries = ({
  parentFolder,
  particleSystemConfig,
  recreateParticleSystem,
}: SourceImageTweakEntriesParams): SourceImageTweakEntriesResult => {
  const folder = parentFolder.addFolder('Source Image Tweak');
  folder.close();

  const ensure = (): { colorTweak: any; luminanceMap: any } => {
    if (!particleSystemConfig.particleColorInstance) {
      particleSystemConfig.particleColorInstance = {
        isActive: false,
        area: { x: 0, z: 0 },
        useAlphaForOpacity: false,
      };
    }
    const ci = particleSystemConfig.particleColorInstance;
    if (!ci.colorTweak) ci.colorTweak = defaultColorTweak();
    if (!ci.luminanceMap) ci.luminanceMap = defaultLuminanceMap();
    const tweakDefaults = defaultColorTweak();
    (Object.keys(tweakDefaults) as Array<keyof typeof tweakDefaults>).forEach((key) => {
      if (ci.colorTweak[key] === undefined) ci.colorTweak[key] = tweakDefaults[key];
    });
    const mapDefaults = defaultLuminanceMap();
    (Object.keys(mapDefaults) as Array<keyof typeof mapDefaults>).forEach((key) => {
      if (ci.luminanceMap[key] === undefined) ci.luminanceMap[key] = mapDefaults[key];
    });
    return { colorTweak: ci.colorTweak, luminanceMap: ci.luminanceMap };
  };
  const { colorTweak, luminanceMap } = ensure();

  const colorFolder = folder.addFolder('Color source');
  colorFolder
    .add(colorTweak, 'saturation', 0, 2, 0.01)
    .name('saturation')
    .onChange(recreateParticleSystem)
    .listen();
  colorFolder
    .add(colorTweak, 'contrast', 0, 2, 0.01)
    .name('level (contrast)')
    .onChange(recreateParticleSystem)
    .listen();
  colorFolder
    .add(colorTweak, 'hue', -180, 180, 1)
    .name('hue (deg)')
    .onChange(recreateParticleSystem)
    .listen();

  const mapFolder = folder.addFolder('Luminosity noise map');
  mapFolder
    .add(luminanceMap, 'black', 0, 1, 0.01)
    .name('darkest (black point)')
    .onChange(recreateParticleSystem)
    .listen();
  mapFolder
    .add(luminanceMap, 'white', 0, 1, 0.01)
    .name('brightest (white point)')
    .onChange(recreateParticleSystem)
    .listen();

  // A loaded config may lack either block; the controllers above are bound to
  // the objects that were there when the panel was built, and a load rebuilds
  // the panel, so all a reset has to do is make sure the blocks exist.
  const onReset = (): void => {
    ensure();
  };

  return { onReset };
};
