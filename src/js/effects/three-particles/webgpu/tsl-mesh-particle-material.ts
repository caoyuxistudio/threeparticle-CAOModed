/**
 * TSL (Three Shading Language) material for the MESH particle renderer.
 *
 * Replicates the behavior of mesh-particle-vertex-shader.glsl.ts and
 * mesh-particle-fragment-shader.glsl.ts using TSL node-based materials.
 *
 * Key differences from the POINTS / INSTANCED TSL materials:
 *  - Uses `instanceQuat` (vec4) for full 3D quaternion rotation of mesh vertices.
 *  - Transforms normals by the same quaternion for per-fragment directional lighting.
 *  - Uses real mesh UVs (`uv`) rather than a derived point-coord or billboard UV.
 *  - No circle discard — mesh geometry defines the particle shape.
 *  - Texture sheet animation is only applied when tiles > 1×1.
 *  - Simple directional lighting: `0.5 + 0.5 * max(dot(vNormal, vec3(0,0,1)), 0.0)`.
 */
import {
  Fn,
  attribute,
  vec2,
  vec3,
  vec4,
  float,
  cameraProjectionMatrix,
  modelViewMatrix,
  positionLocal,
  normalLocal,
  texture,
  cos,
  sin,
  Discard,
  If,
  max,
  abs,
  cross,
  dot,
  normalize,
  varyingProperty,
  uv,
  type ShaderNodeObject,
  type Node,
} from 'three/tsl';
import { MeshBasicNodeMaterial } from 'three/webgpu';

import { ALPHA_DISCARD_THRESHOLD } from '../three-particles-constants.js';
import {
  type SharedUniforms,
  createParticleUniforms,
  computeFrameIndex,
  computeSpriteSheetUV,
  computeSoftParticleFade,
  applyBackgroundDiscard,
} from './tsl-shared.js';

import type * as THREE from 'three';

// ─── Quaternion helper ────────────────────────────────────────────────────────

/**
 * Applies a unit quaternion `q` to vector `v`.
 *
 * Replicates the GLSL helper:
 * ```glsl
 * vec3 applyQuaternion(vec3 v, vec4 q) {
 *   vec3 t = 2.0 * cross(q.xyz, v);
 *   return v + q.w * t + cross(q.xyz, t);
 * }
 * ```
 */
const applyQuaternion = Fn(
  ({ v, q }: Record<string, ShaderNodeObject<Node>>) => {
    const t = cross(q.xyz, v).mul(2.0);
    return v.add(t.mul(q.w)).add(cross(q.xyz, t));
  }
);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Creates a TSL-based {@link MeshBasicNodeMaterial} that replicates the GLSL
 * mesh particle shaders. Works with both WebGPURenderer (WGSL output) and
 * WebGLRenderer (GLSL output) when using the node material system.
 *
 * @param sharedUniforms - Live uniform values shared with the particle system.
 * @param rendererConfig - Blending / depth / transparency settings.
 * @returns A configured {@link MeshBasicNodeMaterial}.
 */
export function createMeshParticleTSLMaterial(
  sharedUniforms: SharedUniforms,
  rendererConfig: {
    transparent: boolean;
    blending: THREE.Blending;
    depthTest: boolean;
    depthWrite: boolean;
  },
  gpuCompute = false,
  alignToVelocity = false
): MeshBasicNodeMaterial {
  const u = createParticleUniforms(sharedUniforms);
  // Velocity alignment needs the compute backend's packed travel direction.
  const useVelocityAlign = alignToVelocity && gpuCompute;

  // ── Per-instance attributes ────────────────────────────────────────────────

  /** Particle world-space position (vec3). */
  const aInstanceOffset = attribute('instanceOffset');
  /** Packed RGBA color (vec4). */
  const aColor = attribute('instanceColor');

  // GPU compute uses packed vec4 buffers; CPU uses individual attributes
  const aParticleState = gpuCompute ? attribute('instanceParticleState') : null;
  /** (vx, vy, vz, travel-direction azimuth). Bound only for velocity alignment. */
  const aVelocity = useVelocityAlign ? attribute('instanceVelocity') : null;
  const aStartValues = gpuCompute ? attribute('instanceStartValues') : null;
  /** Particle orientation as a unit quaternion (vec4: x, y, z, w). CPU path only. */
  const aInstanceQuat = gpuCompute ? null : attribute('instanceQuat');
  const aSize = gpuCompute ? null : attribute('instanceSize');
  const aLifetime = gpuCompute ? null : attribute('instanceLifetime');
  const aStartLifetime = gpuCompute ? null : attribute('instanceStartLifetime');
  const aRotation = gpuCompute ? null : attribute('instanceRotation');
  const aStartFrame = gpuCompute ? null : attribute('instanceStartFrame');

  // ── Varyings ───────────────────────────────────────────────────────────────

  const vColor = varyingProperty('vec4', 'vColor');
  const vLifetime = varyingProperty('float', 'vLifetime');
  const vStartLifetime = varyingProperty('float', 'vStartLifetime');
  const vStartFrame = varyingProperty('float', 'vStartFrame');
  const vRotation = varyingProperty('float', 'vRotation');
  /** View-space normal, transformed by the instance quaternion. */
  const vNormal = varyingProperty('vec3', 'vNormal');
  /** View-space depth (positive distance from camera). */
  const vViewZ = varyingProperty('float', 'vViewZ');

  // ── Vertex stage ───────────────────────────────────────────────────────────

  /**
   * Computes the world-space vertex position for each mesh vertex:
   *   1. Rotate the mesh vertex by the instance quaternion.
   *   2. Scale by instanceSize.
   *   3. Translate by instanceOffset.
   * Also populates all varyings for the fragment stage.
   */
  const vertexSetup = Fn(() => {
    // Early-out for dead particles: push the vertex behind the camera
    // (negative w) so it is clipped before rasterisation. A degenerate
    // (0,0,0,0) position causes a NaN after perspective divide, which some
    // WebGPU drivers rasterise at an indeterminate location instead of
    // discarding cleanly.
    const clipPos = vec4(0.0, 0.0, 0.0, -1.0).toVar();

    If(aColor.w.greaterThan(0.0), () => {
      // Populate varyings
      vColor.assign(aColor.toVar());
      if (gpuCompute) {
        vLifetime.assign(aParticleState!.x);
        vStartLifetime.assign(aStartValues!.x);
        vStartFrame.assign(aParticleState!.w);
        vRotation.assign(aParticleState!.z);
      } else {
        vLifetime.assign(aLifetime!);
        vStartLifetime.assign(aStartLifetime!);
        vStartFrame.assign(aStartFrame!);
        vRotation.assign(aRotation!);
      }

      // Build quaternion: GPU compute derives it from particleState.z (rotation
      // angle around Z); CPU path reads the pre-computed instanceQuat attribute.
      let quat: ShaderNodeObject<Node>;
      if (gpuCompute) {
        const halfZ = aParticleState!.z.mul(0.5);
        quat = vec4(0.0, 0.0, sin(halfZ), cos(halfZ));
      } else {
        quat = aInstanceQuat!;
      }

      // 0. Per-axis scale in the mesh's local frame, BEFORE the rotation, so a
      // non-uniform scale stretches the shape itself rather than shearing it
      // along world axes as the particle spins.
      const localPos = positionLocal.mul(u.uMeshScale);

      // Velocity alignment builds an orthonormal frame from the direction of
      // travel: local +Z maps to the heading, +X/+Y span the perpendicular
      // plane, and the particle's rotation value becomes roll about the
      // heading. Direction arrives as two spherical angles packed into the
      // position (.w = polar) and velocity (.w = azimuth) buffers.
      const buildTravelBasis = () => {
        const theta = aInstanceOffset.w;
        const phi = aVelocity!.w;
        const sinT = sin(theta);
        const forward = vec3(
          sinT.mul(cos(phi)),
          cos(theta),
          sinT.mul(sin(phi))
        ).toVar();

        // Pick a reference that is never parallel to the heading, otherwise the
        // cross product collapses and the frame flips.
        const upRef = vec3(0, 1, 0).toVar();
        If(abs(dot(forward, upRef)).greaterThan(0.999), () => {
          upRef.assign(vec3(0, 0, 1));
        });

        const right = normalize(cross(upRef, forward)).toVar();
        const upv = cross(forward, right).toVar();

        // Roll about the heading, driven by the same rotation value the
        // Z-spin path uses (rotationOverLifetime + noise rotationAmount).
        const roll = gpuCompute ? aParticleState!.z : aRotation!;
        const cr = cos(roll);
        const sr = sin(roll);
        const rolledRight = right.mul(cr).add(upv.mul(sr));
        const rolledUp = upv.mul(cr).sub(right.mul(sr));

        return { right: rolledRight, up: rolledUp, forward };
      };

      // 1. Orient the mesh vertex — either along the travel direction or by
      // the instance quaternion (flat Z-spin).
      let rotatedPos: ShaderNodeObject<Node>;
      let basis: ReturnType<typeof buildTravelBasis> | null = null;
      if (useVelocityAlign) {
        basis = buildTravelBasis();
        rotatedPos = basis.right
          .mul(localPos.x)
          .add(basis.up.mul(localPos.y))
          .add(basis.forward.mul(localPos.z));
      } else {
        rotatedPos = applyQuaternion({
          v: localPos,
          q: quat,
        });
      }

      // 2. Scale by particle size
      const scaledPos = rotatedPos.mul(gpuCompute ? aParticleState!.y : aSize!);

      // 3. Translate to particle world position
      // Use .xyz to handle vec3→vec4 padding by WebGPU storage buffer alignment
      const worldPos = scaledPos.add(aInstanceOffset.xyz);

      // Compute model-view position for depth and normal
      const mvPos = modelViewMatrix.mul(vec4(worldPos, 1.0));
      vViewZ.assign(mvPos.z.negate());

      // Transform normal: normals scale by the inverse-transpose, which for a
      // diagonal scale is a component-wise divide, then rotate into view space.
      const scaledNormal = normalLocal
        .div(max(u.uMeshScale, vec3(0.0001)))
        .normalize();
      const rotatedNormal = basis
        ? basis.right
            .mul(scaledNormal.x)
            .add(basis.up.mul(scaledNormal.y))
            .add(basis.forward.mul(scaledNormal.z))
        : applyQuaternion({
            v: scaledNormal,
            q: quat,
          });
      const mvNormal = modelViewMatrix.mul(vec4(rotatedNormal, 0.0)).xyz;
      vNormal.assign(mvNormal.normalize());

      clipPos.assign(cameraProjectionMatrix.mul(mvPos));
    });

    // Return clip-space position (manual MVP to avoid double-transform)
    return clipPos;
  })();

  // ── Fragment stage ─────────────────────────────────────────────────────────

  const fragmentColor = Fn(() => {
    const outColor = vColor.toVar();

    // Use mesh UVs as the base for texture sampling
    const uvPoint = vec2(uv()).toVar();

    // Texture sheet animation — only applied when tiles > 1×1
    If(u.uTiles.x.greaterThan(1.0).or(u.uTiles.y.greaterThan(1.0)), () => {
      const frameIndex = computeFrameIndex({
        vLifetime,
        vStartLifetime,
        vStartFrame,
        uFps: u.uFps,
        uUseFPSForFrameIndex: u.uUseFPSForFrameIndex,
        uTiles: u.uTiles,
      });

      // Remap mesh UV into the selected tile
      uvPoint.assign(
        computeSpriteSheetUV({
          baseUV: uv(),
          frameIndex,
          uTiles: u.uTiles,
        })
      );
    });

    // Sample texture using the (possibly remapped) UV
    const texColor = texture(u.uMap, uvPoint);
    outColor.assign(outColor.mul(texColor));

    // Background color discard
    applyBackgroundDiscard({
      texColor,
      uDiscardBg: u.uDiscardBg,
      uBgColor: u.uBgColor,
      uBgTolerance: u.uBgTolerance,
    });

    // Simple directional lighting from camera direction (+Z in view space).
    // lightIntensity = 0.5 + 0.5 * max(dot(vNormal, vec3(0,0,1)), 0.0)
    const lightIntensity = float(0.5).add(
      float(0.5).mul(max(dot(vNormal, vec3(0.0, 0.0, 1.0)), float(0.0)))
    );
    outColor.assign(vec4(outColor.xyz.mul(lightIntensity), outColor.w));

    // Soft particles — fade out fragments that are close to opaque scene geometry
    const softFade = computeSoftParticleFade({
      viewZ: vViewZ,
      uSoftEnabled: u.uSoftEnabled,
      uSoftIntensity: u.uSoftIntensity,
      uSceneDepthTex: u.uSceneDepthTex,
      uCameraNearFar: u.uCameraNearFar,
    });
    outColor.assign(vec4(outColor.xyz, outColor.w.mul(softFade)));
    Discard(outColor.w.lessThan(ALPHA_DISCARD_THRESHOLD));

    return outColor;
  })();

  // ── Material assembly ──────────────────────────────────────────────────────

  const material = new MeshBasicNodeMaterial();
  material.transparent = rendererConfig.transparent;
  material.blending = rendererConfig.blending;
  material.depthTest = rendererConfig.depthTest;
  material.depthWrite = rendererConfig.depthWrite;
  material.toneMapped = false;
  material.fog = false;

  // vertexNode receives a clip-space vec4 (manual MVP to avoid double-transform)
  material.vertexNode = vertexSetup;
  material.colorNode = fragmentColor;

  return material;
}
