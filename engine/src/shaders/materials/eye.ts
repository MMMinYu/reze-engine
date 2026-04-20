// Eye preset — default Principled BSDF + Emission socket set to albedo × 1.5.
// Matches the published preset author's instruction: "keep eyes in the default
// nodegraph, add emission 1.5". Emission feeds bloom pre-tonemap.

import { NODES_WGSL } from "./nodes"
import { COMMON_MATERIAL_PRELUDE_WGSL } from "./common"

export const EYE_SHADER_WGSL = /* wgsl */ `

${NODES_WGSL}
${COMMON_MATERIAL_PRELUDE_WGSL}

const EYE_SPECULAR: f32 = 0.5;
const EYE_ROUGHNESS: f32 = 0.5;
const EYE_EMISSION_STRENGTH: f32 = 1.5;

@fragment fn fs(input: VertexOutput) -> FSOut {
  let alpha = material.alpha;
  if (alpha < 0.001) { discard; }

  let n = normalize(input.normal);
  let v = normalize(camera.viewPos - input.worldPos);
  let l = -light.lights[0].direction.xyz;
  let sun = light.lights[0].color.xyz * light.lights[0].color.w;
  let amb = light.ambientColor.xyz;
  let shadow = sampleShadow(input.worldPos, n);

  let albedo = textureSample(diffuseTexture, diffuseSampler, input.uv).rgb;

  let shaded = eval_principled(
    PrincipledIn(albedo, 0.0, EYE_SPECULAR, EYE_ROUGHNESS, 1e30, 0.0, 0.0),
    n, l, v, sun, amb, shadow
  );
  // Principled Emission socket: emissive = emission_color × strength, added on top.
  let emission = albedo * EYE_EMISSION_STRENGTH;

  var out: FSOut;
  out.color = vec4f(shaded + emission, alpha);
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}

`
