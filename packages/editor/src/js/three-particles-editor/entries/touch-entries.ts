type TouchEntriesParams = {
  parentFolder: any;
  particleSystemConfig: any;
  recreateParticleSystem: () => void;
};

type TouchEntriesResult = {
  onReset: () => void;
};

const defaults = () => ({
  isActive: false,
  radius: 0.12,
  strength: 1,
  wake: 0.4,
  swirl: 0.3,
  maxSpeed: 8,
});

/**
 * "Touch" — fingers brushing through the particles. Not a force field: a
 * finger is a trail of velocity splats (library: touch wake), so particles
 * take on its motion where it passes, the effect trails for `wake` seconds,
 * and a still finger does nothing. Fed while presenting and on the player;
 * the radius is a share of the view's width so it is the finger's size,
 * whatever the camera.
 */
export const createTouchEntries = ({
  parentFolder,
  particleSystemConfig,
  recreateParticleSystem,
}: TouchEntriesParams): TouchEntriesResult => {
  const folder = parentFolder.addFolder('Touch');
  folder.close();

  const ensure = (): any => {
    if (!particleSystemConfig.touch) particleSystemConfig.touch = defaults();
    const d = defaults();
    (Object.keys(d) as Array<keyof ReturnType<typeof defaults>>).forEach((key) => {
      if (particleSystemConfig.touch[key] === undefined) particleSystemConfig.touch[key] = d[key];
    });
    return particleSystemConfig.touch;
  };
  const config = ensure();

  // Whether fingers reach the particles is baked into the GPU kernel; the
  // levers are read every frame but a rebuild keeps every path honest.
  folder.add(config, 'isActive').onChange(recreateParticleSystem).listen();
  folder
    .add(config, 'radius', 0.02, 0.5, 0.005)
    .name('radius (share of width)')
    .onChange(recreateParticleSystem)
    .listen();
  folder
    .add(config, 'strength', 0, 3, 0.01)
    .name('strength')
    .onChange(recreateParticleSystem)
    .listen();
  folder
    .add(config, 'wake', 0.05, 2, 0.01)
    .name('wake (s)')
    .onChange(recreateParticleSystem)
    .listen();
  folder.add(config, 'swirl', 0, 2, 0.01).name('swirl').onChange(recreateParticleSystem).listen();
  folder
    .add(config, 'maxSpeed', 1, 30, 0.5)
    .name('max finger speed')
    .onChange(recreateParticleSystem)
    .listen();

  const onReset = (): void => {
    ensure();
  };

  return { onReset };
};
