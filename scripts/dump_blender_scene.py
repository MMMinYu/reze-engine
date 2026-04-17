"""
Dump Blender scene settings to JSON for comparison against reze-engine defaults.

Usage in Blender:
  1. Open the reference .blend file.
  2. Go to Scripting workspace, open this file (or paste contents).
  3. Run. Output goes to stdout and to ~/reze_blender_dump.json next to the .blend.

Or headless:
  blender reference.blend --background --python scripts/dump_blender_scene.py

Covers: render engine, color management (view transform / exposure / gamma / look),
world (flat RGB vs HDRI environment texture), every lamp (sun/point/spot with
Blender-unit strength and direction vector), EEVEE render settings (bloom, GTAO,
SSR, shadow map resolution), and active camera framing.
"""

import bpy
import json
import math
import os


def vec(v, n=3):
    return [round(float(v[i]), 6) for i in range(n)]


def node_input_value(socket):
    """Read a shader node socket's default_value; return (value, linked_node_name)."""
    linked = socket.links[0].from_node.name if socket.is_linked else None
    if hasattr(socket, "default_value"):
        dv = socket.default_value
        if hasattr(dv, "__len__"):
            return {"value": [round(float(x), 6) for x in dv], "linked": linked}
        return {"value": round(float(dv), 6), "linked": linked}
    return {"value": None, "linked": linked}


def dump_world(world):
    if world is None:
        return None
    out = {
        "name": world.name,
        "use_nodes": world.use_nodes,
        "color_viewport": vec(world.color),  # viewport fallback color
    }
    if not world.use_nodes or not world.node_tree:
        return out

    nt = world.node_tree
    # Find the Background and Output nodes
    bg_nodes = [n for n in nt.nodes if n.type == "BACKGROUND"]
    env_nodes = [n for n in nt.nodes if n.type == "TEX_ENVIRONMENT"]
    out["background_count"] = len(bg_nodes)
    if bg_nodes:
        bg = bg_nodes[0]
        out["background"] = {
            "color": node_input_value(bg.inputs["Color"]),
            "strength": node_input_value(bg.inputs["Strength"]),
        }
    if env_nodes:
        out["environment_textures"] = []
        for env in env_nodes:
            img = env.image
            out["environment_textures"].append({
                "node_name": env.name,
                "image": img.filepath if img else None,
                "image_source": img.source if img else None,
                "projection": env.projection,
                "interpolation": env.interpolation,
            })
    return out


def dump_light(obj):
    light = obj.data
    # World-space direction the light travels (negative local Z).
    mw = obj.matrix_world
    local_dir = (0.0, 0.0, -1.0)
    world_dir = (
        mw[0][0] * local_dir[0] + mw[0][1] * local_dir[1] + mw[0][2] * local_dir[2],
        mw[1][0] * local_dir[0] + mw[1][1] * local_dir[1] + mw[1][2] * local_dir[2],
        mw[2][0] * local_dir[0] + mw[2][1] * local_dir[1] + mw[2][2] * local_dir[2],
    )
    mag = math.sqrt(sum(x * x for x in world_dir)) or 1.0
    world_dir = tuple(x / mag for x in world_dir)
    info = {
        "name": obj.name,
        "type": light.type,  # 'SUN' | 'POINT' | 'SPOT' | 'AREA'
        "color": vec(light.color),
        "energy": round(float(light.energy), 6),  # Blender unit: W/m² for SUN, W for POINT
        "location": vec(obj.location),
        "direction_world": [round(x, 6) for x in world_dir],
        "use_shadow": light.use_shadow,
    }
    if light.type == "SUN":
        info["angle_rad"] = round(float(light.angle), 6)
    if light.type in ("SPOT", "POINT"):
        info["shadow_soft_size"] = round(float(light.shadow_soft_size), 6)
    if light.type == "SPOT":
        info["spot_size_rad"] = round(float(light.spot_size), 6)
        info["spot_blend"] = round(float(light.spot_blend), 6)
    return info


def dump_color_management(scene):
    vs = scene.view_settings
    ds = scene.display_settings
    sq = scene.sequencer_colorspace_settings if hasattr(scene, "sequencer_colorspace_settings") else None
    out = {
        "display_device": ds.display_device,
        "view_transform": vs.view_transform,
        "look": vs.look,
        "exposure": round(float(vs.exposure), 6),
        "gamma": round(float(vs.gamma), 6),
        "use_curve_mapping": vs.use_curve_mapping,
    }
    if sq:
        out["sequencer_colorspace"] = sq.name
    return out


def dump_eevee(scene):
    """Blender 3.x uses eevee; 4.2+ uses eevee_next. Handle both."""
    e = getattr(scene, "eevee", None)
    if e is None:
        return {"available": False}
    out = {"available": True}

    # Bloom (removed in 4.2)
    if hasattr(e, "use_bloom"):
        out["bloom"] = {
            "enabled": e.use_bloom,
            "threshold": round(float(e.bloom_threshold), 6),
            "knee": round(float(e.bloom_knee), 6),
            "radius": round(float(e.bloom_radius), 6),
            "color": vec(e.bloom_color),
            "intensity": round(float(e.bloom_intensity), 6),
            "clamp": round(float(e.bloom_clamp), 6),
        }

    # Ambient Occlusion
    if hasattr(e, "use_gtao"):
        out["gtao"] = {
            "enabled": e.use_gtao,
            "distance": round(float(e.gtao_distance), 6),
            "factor": round(float(e.gtao_factor), 6),
            "quality": round(float(e.gtao_quality), 6),
        }

    # Screen Space Reflections
    if hasattr(e, "use_ssr"):
        out["ssr"] = {
            "enabled": e.use_ssr,
            "refraction": e.use_ssr_refraction,
            "quality": round(float(e.ssr_quality), 6),
            "max_roughness": round(float(e.ssr_max_roughness), 6),
        }

    # Shadows
    if hasattr(e, "shadow_cube_size"):
        out["shadows"] = {
            "cube_size": e.shadow_cube_size,
            "cascade_size": e.shadow_cascade_size,
            "use_soft_shadows": getattr(e, "use_soft_shadows", None),
            "shadow_normal_bias": getattr(e, "shadow_normal_bias", None),
        }

    # Indirect lighting
    if hasattr(e, "use_gi_auto_bake"):
        out["indirect"] = {
            "diffuse_bounces": e.gi_diffuse_bounces,
            "cubemap_resolution": e.gi_cubemap_resolution,
            "visibility_resolution": e.gi_visibility_resolution,
            "irradiance_smoothing": round(float(e.gi_irradiance_smoothing), 6),
        }

    # Volumetrics
    if hasattr(e, "volumetric_start"):
        out["volumetric"] = {
            "start": round(float(e.volumetric_start), 6),
            "end": round(float(e.volumetric_end), 6),
            "tile_size": e.volumetric_tile_size,
            "samples": e.volumetric_samples,
        }

    # Sampling / TAA
    if hasattr(e, "taa_samples"):
        out["sampling"] = {
            "taa_samples": e.taa_samples,
            "taa_render_samples": e.taa_render_samples,
        }

    return out


def dump_render(scene):
    r = scene.render
    return {
        "engine": r.engine,
        "resolution": [r.resolution_x, r.resolution_y],
        "resolution_percentage": r.resolution_percentage,
        "fps": r.fps,
        "film_transparent": r.film_transparent,
        "filter_size": round(float(r.filter_size), 6),
    }


def dump_camera(scene):
    cam = scene.camera
    if cam is None:
        return None
    d = cam.data
    return {
        "name": cam.name,
        "type": d.type,
        "lens_mm": round(float(d.lens), 6),
        "sensor_width_mm": round(float(d.sensor_width), 6),
        "sensor_height_mm": round(float(d.sensor_height), 6),
        "fov_rad": round(2.0 * math.atan((d.sensor_width / 2.0) / d.lens), 6),
        "clip_start": round(float(d.clip_start), 6),
        "clip_end": round(float(d.clip_end), 6),
        "location": vec(cam.location),
        "rotation_euler": vec(cam.rotation_euler),
    }


def main():
    scene = bpy.context.scene
    dump = {
        "blend_file": bpy.data.filepath or "(unsaved)",
        "blender_version": bpy.app.version_string,
        "scene_name": scene.name,
        "render": dump_render(scene),
        "color_management": dump_color_management(scene),
        "eevee": dump_eevee(scene),
        "world": dump_world(scene.world),
        "camera": dump_camera(scene),
        "lights": [dump_light(o) for o in scene.objects if o.type == "LIGHT"],
    }

    text = json.dumps(dump, indent=2, ensure_ascii=False)
    print("\n────────── REZE ENGINE scene dump ──────────")
    print(text)
    print("────────── end dump ──────────\n")

    blend_dir = os.path.dirname(bpy.data.filepath) if bpy.data.filepath else os.path.expanduser("~")
    out_path = os.path.join(blend_dir, "reze_blender_dump.json")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"Saved to: {out_path}")


if __name__ == "__main__":
    main()
