const MeshParticleVertexShader = `
  attribute float instanceSize;
  attribute vec4 instanceColor;
  attribute float instanceLifetime;
  attribute float instanceStartLifetime;
  attribute float instanceRotation;
  attribute float instanceStartFrame;
  attribute vec3 instanceOffset;
  attribute vec4 instanceQuat;

  uniform vec3 meshScale;

  varying vec4 vColor;
  varying float vLifetime;
  varying float vStartLifetime;
  varying float vStartFrame;
  varying float vRotation;
  varying vec3 vNormal;
  varying vec2 vUv;
  varying float vViewZ;

  #include <common>
  #include <logdepthbuf_pars_vertex>

  vec3 applyQuaternion(vec3 v, vec4 q) {
    vec3 t = 2.0 * cross(q.xyz, v);
    return v + q.w * t + cross(q.xyz, t);
  }

  void main()
  {
    // Early-out for dead particles: skip all expensive transforms and emit
    // a degenerate position that produces zero-area triangles.
    if (instanceColor.a <= 0.0) {
      gl_Position = vec4(0.0, 0.0, 0.0, 0.0);
      return;
    }

    vColor = instanceColor;
    vLifetime = instanceLifetime;
    vStartLifetime = instanceStartLifetime;
    vStartFrame = instanceStartFrame;
    vRotation = instanceRotation;

    // Per-axis scale is applied in the mesh's local frame, BEFORE the rotation,
    // so a non-uniform scale stretches the shape itself. Scaling after the
    // rotation would stretch along world axes and shear the mesh as it spins.
    vec3 localPosition = position * meshScale;

    // Apply quaternion rotation to the mesh vertex position
    vec3 rotatedPosition = applyQuaternion(localPosition, instanceQuat);

    // Scale mesh by particle size
    vec3 scaledPosition = rotatedPosition * instanceSize;

    // Apply instance offset (particle world position)
    vec3 worldPos = scaledPosition + instanceOffset;

    vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
    vViewZ = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;

    // Transform normal by quaternion for lighting
    // Normals transform by the inverse-transpose of the scale, which for a
    // diagonal scale is a component-wise divide — without this a non-uniform
    // meshScale would light the surface as if it were unscaled.
    vec3 scaledNormal = normalize(normal / max(meshScale, vec3(0.0001)));
    vNormal = normalize((modelViewMatrix * vec4(applyQuaternion(scaledNormal, instanceQuat), 0.0)).xyz);

    // Pass through UVs from the mesh geometry
    vUv = uv;

    #include <logdepthbuf_vertex>
  }
`;

export default MeshParticleVertexShader;
