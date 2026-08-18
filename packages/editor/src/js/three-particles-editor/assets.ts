import * as THREE from "three";

import { textureConfigs } from "./texture-config";

const textureLoader = new THREE.TextureLoader();




export const getTexture = (id: string) =>
  textureConfigs.find(({ id: configId }) => configId === id);


const loadTextures = ({ 
  textureConfigs, 
  onComplete 
}: { 
  textureConfigs: any[]; 
  onComplete: () => void;
}) => {
  if (textureConfigs.length === 0) {
    onComplete();
    return;
  }

  const { id, url } = textureConfigs[0];

  // Continue the chain regardless of the outcome. Without this, a single
  // undecodable image stalls the whole serial load: at startup that leaves the
  // editor without a panel, and after an upload it means the caller's
  // `onComplete` (which persists the library) never runs, so the image silently
  // vanishes on the next reload.
  const next = () => {
    if (textureConfigs.length > 1)
      loadTextures({ textureConfigs: textureConfigs.slice(1), onComplete });
    else onComplete();
  };

  textureLoader.load(
    url,
    (texture) => {
      // texture.flipX = false; // flipX property doesn't exist on THREE.Texture
      texture.flipY = false;
      const textureConfig = getTexture(id);
      if (textureConfig) {
        (textureConfig as any).map = texture;
      }
      next();
    },
    undefined,
    (error) => {
      console.warn(`Failed to load texture "${id}" - skipping it.`, error);
      next();
    }
  );
};


export const loadCustomAssets = ({ 
  textures, 
  onComplete 
}: { 
  textures: { id: string; url: string; }[]; 
  onComplete: () => void;
}) => {
  if (textures.length === 0) {
    onComplete();
    return;
  }

  textures.forEach(({ id, url }) => textureConfigs.push({ id, url }));
  loadTextures({
    textureConfigs: [...textures],
    onComplete,
  });
};


export const initAssets = (onComplete: () => void) =>
  loadTextures({ textureConfigs: [...textureConfigs], onComplete });
