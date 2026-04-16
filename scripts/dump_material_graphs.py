#!/usr/bin/env python3
"""
Export Blender material node graphs with explicit socket identifiers (stable for WGSL ports).

Requires Blender's bpy. Do not run with system python.

Usage (from shell):
  blender /path/to/your_scene.blend --background --python scripts/dump_material_graphs.py

Optional: pass output path as argv after -- (Blender forwards args after --):
  blender scene.blend --background --python scripts/dump_material_graphs.py -- /tmp/out.json

Or paste into Blender's Scripting workspace and Run Script (uses open file's data).

Output JSON shape per material:
  {
    "name": "M_Hair",
    "nodes": { "NodeName": { "type": "...", "params": {...}, "bl_idname": "..." }, ... },
    "links": [
      { "from_node", "from_socket_id", "from_socket_name",
        "to_node", "to_socket_id", "to_socket_name" },
      ...
    ]
  }

Socket ids (e.g. \"Color\", \"Fac\", \"Shader\") match bpy NodeSocket.identifier and survive locale.
"""

from __future__ import annotations

import json
import sys
from typing import Any


def _socket_id(sock) -> tuple[str, str]:
    ident = getattr(sock, "identifier", "") or ""
    name = getattr(sock, "name", "") or ""
    return ident, name


def _serialize_default(val: Any) -> Any:
    if val is None:
        return None
    if isinstance(val, (bool, int, str)):
        return val
    if isinstance(val, float):
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


def dump_material(mat) -> dict[str, Any]:
    nt = mat.node_tree
    if nt is None:
        return {"name": mat.name, "error": "no node tree"}

    nodes_out: dict[str, Any] = {}
    for node in nt.nodes:
        inputs: dict[str, Any] = {}
        for sock in getattr(node, "inputs", []):
            ident = getattr(sock, "identifier", "") or sock.name
            if getattr(sock, "is_linked", False):
                continue
            if hasattr(sock, "default_value"):
                inputs[ident] = _serialize_default(sock.default_value)

        nodes_out[node.name] = {
            "bl_idname": getattr(node, "bl_idname", ""),
            "type": getattr(node, "bl_idname", ""),
            "unlinked_input_defaults": inputs,
        }

    links_out: list[dict[str, str]] = []
    for link in nt.links:
        fn = link.from_node.name
        tn = link.to_node.name
        fi, fnm = _socket_id(link.from_socket)
        ti, tnm = _socket_id(link.to_socket)
        links_out.append(
            {
                "from_node": fn,
                "from_socket_id": fi,
                "from_socket_name": fnm,
                "to_node": tn,
                "to_socket_id": ti,
                "to_socket_name": tnm,
            }
        )

    return {"name": mat.name, "nodes": nodes_out, "links": links_out}


def main() -> None:
    try:
        import bpy
    except ImportError:
        print("Run inside Blender: blender file.blend --background --python ...", file=sys.stderr)
        sys.exit(1)

    argv = sys.argv
    if "--" in argv:
        out_path = argv[argv.index("--") + 1]
    else:
        out_path = None

    # Materials whose name starts with M_ (preset exports); change filter as needed.
    materials = [m for m in bpy.data.materials if m.name.startswith("M_")]
    materials.sort(key=lambda m: m.name)

    payload = {
        "blender_version": ".".join(str(x) for x in bpy.app.version),
        "materials": [dump_material(m) for m in materials],
    }

    text = json.dumps(payload, indent=2, ensure_ascii=False)

    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"Wrote {len(materials)} materials to {out_path}")
    else:
        blend = bpy.data.filepath
        if blend:
            default = blend.replace(".blend", "_material_graph_dump.json")
        else:
            default = "material_graph_dump.json"
        with open(default, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"Wrote {len(materials)} materials to {default}")


if __name__ == "__main__":
    main()
