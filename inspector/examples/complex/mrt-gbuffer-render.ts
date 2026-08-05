// @ts-nocheck
export async function inspect({ root, tgpu, d, std }) {
  const Vertex = d.struct({
    position: d.vec3f,
    normal: d.vec3f,
    uv: d.vec2f,
  });

  const Material = d.struct({
    baseColor: d.vec3f,
    roughness: d.f32,
    emissive: d.vec3f,
    time: d.f32,
  });

  const vertexLayout = tgpu.vertexLayout(d.arrayOf(Vertex));
  const vertexBuffer = root
    .createBuffer(d.arrayOf(Vertex, 3), [
      { position: d.vec3f(-0.7, -0.6, 0), normal: d.vec3f(0, 0, 1), uv: d.vec2f(0, 0) },
      { position: d.vec3f(0.7, -0.6, 0), normal: d.vec3f(0, 0, 1), uv: d.vec2f(1, 0) },
      { position: d.vec3f(0, 0.75, 0), normal: d.vec3f(0, 0, 1), uv: d.vec2f(0.5, 1) },
    ])
    .$usage('vertex');

  const frameLayout = tgpu
    .bindGroupLayout({
      material: { uniform: Material },
    })
    .$idx(1);

  const material = root.createBuffer(Material, {
    baseColor: d.vec3f(0.85, 0.26, 0.2),
    roughness: 0.42,
    emissive: d.vec3f(0.05, 0.12, 0.22),
    time: 1.75,
  }).$usage('uniform');

  const frameBindGroup = root.createBindGroup(frameLayout, { material });

  const vertex = tgpu.vertexFn({
    in: {
      position: d.vec3f,
      normal: d.vec3f,
      uv: d.vec2f,
    },
    out: {
      position: d.builtin.position,
      worldPos: d.vec3f,
      normal: d.vec3f,
      uv: d.vec2f,
    },
  })((input) => {
    'use gpu';
    const wave = std.sin(frameLayout.$.material.time + input.uv.x * 6.28318530718) * 0.035;
    const worldPos = input.position + input.normal * wave;

    return {
      position: d.vec4f(worldPos, 1),
      worldPos,
      normal: std.normalize(input.normal),
      uv: input.uv,
    };
  });

  const fragment = tgpu.fragmentFn({
    in: {
      worldPos: d.vec3f,
      normal: d.vec3f,
      uv: d.vec2f,
    },
    out: {
      albedo: d.vec4f,
      normalRoughness: d.vec4f,
      emissive: d.vec4f,
    },
  })((input) => {
    'use gpu';
    const material = frameLayout.$.material;
    const stripes = std.smoothstep(0.45, 0.55, std.fract(input.uv.x * 8 + input.uv.y * 3));
    const albedo = std.mix(material.baseColor, d.vec3f(0.1, 0.7, 0.95), stripes * 0.25);
    const encodedNormal = std.normalize(input.normal) * 0.5 + 0.5;
    const rim = 1 - std.clamp(std.abs(input.worldPos.z) + std.dot(encodedNormal, d.vec3f(0, 0, 1)), 0, 1);

    return {
      albedo: d.vec4f(albedo, 1),
      normalRoughness: d.vec4f(encodedNormal, material.roughness),
      emissive: d.vec4f(material.emissive + d.vec3f(rim * 0.25), 1),
    };
  });

  return {
    label: 'mrt gbuffer render',
    kind: 'render-pipeline',
    value: root
      .createRenderPipeline({
        attribs: vertexLayout.attrib,
        vertex,
        fragment,
        targets: {
          albedo: { format: 'rgba8unorm' },
          normalRoughness: { format: 'rgba16float' },
          emissive: { format: 'rgba16float' },
        },
        primitive: { cullMode: 'back' },
      })
      .with(vertexLayout, vertexBuffer)
      .with(frameBindGroup),
  };
}

