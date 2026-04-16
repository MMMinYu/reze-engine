#!/usr/bin/env python3
"""
Dump Blender scene world shader + viewport shading + color management + EEVEE settings.
Also exports any environment texture referenced by the world to a sidecar file.

Usage (from shell):
  blender /path/to/your_scene.blend --background --python scripts/dump_scene_world.py

Optional output dir after `--`:
  blender scene.blend --background --python scripts/dump_scene_world.py -- /tmp/out

Writes:
  <out>/world_dump.json            — JSON payload described below
  <out>/world_env_<name>.<ext>     — copy of any image texture referenced by the world
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from typing import Any


def _ser(val: Any) -> Any:
    if val is None or isinstance(val, (bool, int, str, float)):
        return val
    try:
        if hasattr(val, "__len__") and not isinstance(val, (str, bytes)):
            return [float(x) for x in val]
    except Exception:
        pass
    try:
        return float(val)
    except Exception:
        return str(val)


def dump_node_tree(nt) -> dict[str, Any]:
    if nt is None:
        return {"error": "no node tree"}

    nodes_out: dict[str, Any] = {}
    for node in nt.nodes:
        inputs: dict[str, Any] = {}
        for sock in getattr(node, "inputs", []):
            ident = getattr(sock, "identifier", "") or sock.name
            if getattr(sock, "is_linked", False):
                continue
            if hasattr(sock, "default_value"):
                inputs[ident] = _ser(sock.default_value)

        entry: dict[str, Any] = {
            "bl_idname": getattr(node, "bl_idname", ""),
            "unlinked_input_defaults": inputs,
        }

        # Capture image reference for env textures.
        img = getattr(node, "image", None)
        if img is not None:
            entry["image"] = {
                "name": img.name,
                "filepath": img.filepath,
                "filepath_raw": getattr(img, "filepath_raw", ""),
                "source": getattr(img, "source", ""),
                "colorspace": getattr(getattr(img, "colorspace_settings", None), "name", ""),
                "size": [img.size[0], img.size[1]] if hasattr(img, "size") else None,
                "has_data": bool(getattr(img, "has_data", False)),
                "packed": bool(len(getattr(img, "packed_files", []))),
            }

        # Projection / interpolation for env texture nodes.
        for attr in ("projection", "interpolation", "image_user"):
            if hasattr(node, attr) and attr != "image_user":
                entry[attr] = getattr(node, attr, None)
                if not isinstance(entry[attr], (str, int, float, bool)):
                    entry[attr] = str(entry[attr])

        # Mapping node rotation/location/scale exposed as sockets already; skip.
        nodes_out[node.name] = entry

    links_out: list[dict[str, str]] = []
    for link in nt.links:
        links_out.append(
            {
                "from_node": link.from_node.name,
                "from_socket_id": getattr(link.from_socket, "identifier", "") or link.from_socket.name,
                "from_socket_name": link.from_socket.name,
                "to_node": link.to_node.name,
                "to_socket_id": getattr(link.to_socket, "identifier", "") or link.to_socket.name,
                "to_socket_name": link.to_socket.name,
            }
        )

    return {"nodes": nodes_out, "links": links_out}


def export_world_images(world, out_dir: str) -> list[dict[str, Any]]:
    """Save any image texture referenced by the world into out_dir. Returns list of records."""
    records: list[dict[str, Any]] = []
    if world is None or world.node_tree is None:
        return records

    os.makedirs(out_dir, exist_ok=True)
    seen: set[str] = set()
    for node in world.node_tree.nodes:
        img = getattr(node, "image", None)
        if img is None or img.name in seen:
            continue
        seen.add(img.name)

        safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in img.name)
        src_path = bpy_path_abspath(img.filepath) if img.filepath else ""

        exported_path: str | None = None
        method: str | None = None

        try:
            if len(getattr(img, "packed_files", [])) > 0:
                # Packed image: save out via save_render to a deterministic path.
                ext = os.path.splitext(safe)[1] or ".hdr"
                exported_path = os.path.join(out_dir, f"world_env_{safe}")
                if not exported_path.endswith(ext):
                    exported_path += ext
                img.save_render(exported_path)
                method = "save_render(packed)"
            elif src_path and os.path.isfile(src_path):
                ext = os.path.splitext(src_path)[1] or ".hdr"
                exported_path = os.path.join(out_dir, f"world_env_{safe}")
                if not exported_path.endswith(ext):
                    exported_path += ext
                shutil.copy2(src_path, exported_path)
                method = "copy_from_filepath"
            else:
                # Last resort: save_render uses current data (may be generated/blank).
                ext = ".hdr"
                exported_path = os.path.join(out_dir, f"world_env_{safe}{ext}")
                img.save_render(exported_path)
                method = "save_render(fallback)"
        except Exception as e:
            records.append({"name": img.name, "error": str(e)})
            continue

        records.append(
            {
                "name": img.name,
                "node": node.name,
                "source_filepath": src_path,
                "exported_to": exported_path,
                "method": method,
                "size": [img.size[0], img.size[1]] if hasattr(img, "size") else None,
                "colorspace": getattr(getattr(img, "colorspace_settings", None), "name", ""),
            }
        )
    return records


def bpy_path_abspath(p: str) -> str:
    try:
        import bpy
        return bpy.path.abspath(p) if p else ""
    except Exception:
        return p


def dump_viewport_shading(scene) -> dict[str, Any]:
    """Viewport shading settings are per-3D-view-area; walk windows to find them."""
    import bpy
    result: dict[str, Any] = {"areas": []}
    for window in bpy.data.window_managers[0].windows if bpy.data.window_managers else []:
        screen = window.screen
        for area in screen.areas:
            if area.type != "VIEW_3D":
                continue
            for space in area.spaces:
                if space.type != "VIEW_3D":
                    continue
                sh = space.shading
                result["areas"].append(
                    {
                        "type": sh.type,  # WIREFRAME/SOLID/MATERIAL/RENDERED
                        "use_scene_world": getattr(sh, "use_scene_world", None),
                        "use_scene_world_render": getattr(sh, "use_scene_world_render", None),
                        "use_scene_lights": getattr(sh, "use_scene_lights", None),
                        "use_scene_lights_render": getattr(sh, "use_scene_lights_render", None),
                        "studio_light": getattr(sh, "studio_light", None),
                        "studiolight_rotate_z": getattr(sh, "studiolight_rotate_z", None),
                        "studiolight_intensity": getattr(sh, "studiolight_intensity", None),
                        "studiolight_background_alpha": getattr(sh, "studiolight_background_alpha", None),
                        "studiolight_background_blur": getattr(sh, "studiolight_background_blur", None),
                    }
                )
    return result


def dump_eevee(scene) -> dict[str, Any]:
    r = scene.render
    eev = getattr(scene, "eevee", None)
    out: dict[str, Any] = {
        "engine": r.engine,
        "resolution_x": r.resolution_x,
        "resolution_y": r.resolution_y,
        "resolution_percentage": r.resolution_percentage,
    }
    if eev is None:
        return out

    def g(attr: str) -> Any:
        return _ser(getattr(eev, attr, None))

    # Generic EEVEE settings — some attrs may not exist across versions; guarded by getattr.
    for attr in [
        "use_bloom",
        "bloom_threshold",
        "bloom_knee",
        "bloom_radius",
        "bloom_color",
        "bloom_intensity",
        "bloom_clamp",
        "use_ssr",
        "use_ssr_halfres",
        "use_ssr_refraction",
        "ssr_quality",
        "ssr_max_roughness",
        "ssr_thickness",
        "ssr_border_fade",
        "ssr_firefly_fac",
        "use_gtao",
        "gtao_distance",
        "gtao_factor",
        "gtao_quality",
        "use_gtao_bent_normals",
        "use_gtao_bounce",
        "taa_samples",
        "taa_render_samples",
        "use_taa_reprojection",
        "use_soft_shadows",
        "shadow_cube_size",
        "shadow_cascade_size",
        "use_shadow_high_bitdepth",
        "use_volumetric_shadows",
        "volumetric_start",
        "volumetric_end",
        "gi_auto_bake",
        "gi_cubemap_resolution",
        "gi_visibility_resolution",
        "gi_diffuse_bounces",
        "gi_cubemap_display_size",
        "gi_irradiance_smoothing",
        "gi_glossy_clamp",
        "gi_filter_quality",
        "gi_show_cubemaps",
        "gi_show_irradiance",
    ]:
        out[attr] = g(attr)
    return out


def dump_color_management(scene) -> dict[str, Any]:
    cm = scene.view_settings
    dcm = scene.display_settings
    sq = scene.sequencer_colorspace_settings
    return {
        "display_device": getattr(dcm, "display_device", None),
        "view_transform": getattr(cm, "view_transform", None),
        "look": getattr(cm, "look", None),
        "exposure": _ser(getattr(cm, "exposure", None)),
        "gamma": _ser(getattr(cm, "gamma", None)),
        "use_curve_mapping": _ser(getattr(cm, "use_curve_mapping", None)),
        "sequencer_colorspace": getattr(sq, "name", None),
    }


def dump_sun_lights(scene) -> list[dict[str, Any]]:
    import bpy
    out: list[dict[str, Any]] = []
    for obj in scene.objects:
        if obj.type != "LIGHT":
            continue
        ld = obj.data
        entry = {
            "object_name": obj.name,
            "type": ld.type,
            "color": _ser(ld.color),
            "energy": _ser(ld.energy),
            "use_shadow": _ser(getattr(ld, "use_shadow", None)),
            "world_matrix": [list(row) for row in obj.matrix_world],
        }
        if ld.type == "SUN":
            entry["angle"] = _ser(getattr(ld, "angle", None))
        out.append(entry)
    return out


def main() -> None:
    try:
        import bpy
    except ImportError:
        print("Run inside Blender: blender file.blend --background --python ...", file=sys.stderr)
        sys.exit(1)

    argv = sys.argv
    if "--" in argv and len(argv) > argv.index("--") + 1:
        out_dir = argv[argv.index("--") + 1]
    else:
        blend_dir = os.path.dirname(bpy.data.filepath) if bpy.data.filepath else "."
        out_dir = blend_dir

    os.makedirs(out_dir, exist_ok=True)

    scene = bpy.context.scene
    world = scene.world

    world_record: dict[str, Any] = {
        "name": world.name if world else None,
        "use_nodes": bool(world.use_nodes) if world else False,
    }
    if world:
        world_record["color"] = _ser(world.color)
        if world.use_nodes:
            world_record["node_tree"] = dump_node_tree(world.node_tree)

    image_records = export_world_images(world, out_dir) if world else []

    payload = {
        "blender_version": ".".join(str(x) for x in bpy.app.version),
        "blend_filepath": bpy.data.filepath,
        "scene_name": scene.name,
        "world": world_record,
        "exported_world_images": image_records,
        "viewport_shading": dump_viewport_shading(scene),
        "color_management": dump_color_management(scene),
        "eevee": dump_eevee(scene),
        "lights": dump_sun_lights(scene),
    }

    out_path = os.path.join(out_dir, "world_dump.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    print(f"Wrote {out_path}")
    for rec in image_records:
        print(f"  image: {rec.get('name')} -> {rec.get('exported_to')} ({rec.get('method')})")


if __name__ == "__main__":
    main()
