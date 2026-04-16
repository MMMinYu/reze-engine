"""Trace m_graphs.json into readable signal-flow for each M_ material.
Outputs a topologically-sorted list of computations per material,
with all Chinese node names decoded and connections explicit."""

import json, sys
from collections import defaultdict, deque

with open("m_graphs.json", "r", encoding="utf-8") as f:
    data = json.load(f)

MATERIALS = ["M_Face", "M_Body", "M_Hair", "M_Smooth_Cloth"]

for mat_name in MATERIALS:
    if mat_name not in data:
        print(f"=== {mat_name}: NOT FOUND ===\n")
        continue
    mat = data[mat_name]
    nodes = mat["nodes"]
    links = mat["links"]

    print(f"{'='*80}")
    print(f"  {mat_name}")
    print(f"{'='*80}")

    print(f"\n--- NODES ({len(nodes)}) ---")
    for name, info in nodes.items():
        ntype = info["type"]
        parts = [f"  {name}: {ntype}"]
        if "operation" in info:
            parts.append(f"op={info['operation']}")
        if "blend_type" in info:
            parts.append(f"blend={info['blend_type']}")
        if "interpolation" in info:
            parts.append(f"interp={info['interpolation']}")
        if "stops" in info:
            stops_str = " | ".join(
                f"pos={s['pos']:.4f} col=({s['color'][0]:.4f},{s['color'][1]:.4f},{s['color'][2]:.4f})"
                for s in info["stops"]
            )
            parts.append(f"stops=[{stops_str}]")
        params = info.get("params", {})
        if params:
            param_strs = []
            for k, v in params.items():
                if k in ("Normal", "Tangent", "Clearcoat Normal", "Displacement") and v == [0,0,0]:
                    continue
                if k == "Weight" and v == 0.0:
                    continue
                if isinstance(v, list):
                    param_strs.append(f"{k}=({','.join(f'{x:.4f}' for x in v)})")
                else:
                    param_strs.append(f"{k}={v}")
            if param_strs:
                parts.append(f"params={{ {', '.join(param_strs)} }}")
        print(" | ".join(parts))

    print(f"\n--- LINKS ({len(links)}) ---")

    # Build adjacency: for each node, what feeds into it and what it feeds
    incoming = defaultdict(list)  # node.socket -> [(from_node, from_socket)]
    outgoing = defaultdict(list)  # node.socket -> [(to_node, to_socket)]

    for link in links:
        fr = link["from"]
        to = link["to"]
        print(f"  {fr}  -->  {to}")
        # parse "node_name.socket_name"
        fr_parts = fr.rsplit(".", 1)
        to_parts = to.rsplit(".", 1)
        incoming[to].append(fr)
        outgoing[fr].append(to)

    # Find OUTPUT_MATERIAL and trace backward
    output_node = None
    for name, info in nodes.items():
        if info["type"] == "OUTPUT_MATERIAL":
            output_node = name
            break

    if output_node:
        print(f"\n--- BACKWARD TRACE from {output_node} ---")
        visited = set()
        queue = deque()
        # Find all links going TO the output node
        for link in links:
            to = link["to"]
            if to.startswith(output_node + "."):
                queue.append(link["from"])

        trace_order = []
        while queue:
            current = queue.popleft()
            if current in visited:
                continue
            visited.add(current)
            # Find the node name from this socket ref
            node_name = current.rsplit(".", 1)[0]
            trace_order.append(node_name)
            # Find all links feeding into this node
            for link in links:
                to = link["to"]
                to_node = to.rsplit(".", 1)[0]
                if to_node == node_name and link["from"] not in visited:
                    queue.append(link["from"])

        # Print in reverse (sources first)
        print("  Evaluation order (sources → output):")
        for node_name in reversed(trace_order):
            if node_name in nodes:
                info = nodes[node_name]
                # Find what feeds in and what it feeds out
                feeds_in = []
                feeds_out = []
                for link in links:
                    to_node = link["to"].rsplit(".", 1)[0]
                    fr_node = link["from"].rsplit(".", 1)[0]
                    if to_node == node_name:
                        feeds_in.append(f"{link['from']} → {link['to'].rsplit('.', 1)[1]}")
                    if fr_node == node_name:
                        feeds_out.append(f"{link['from'].rsplit('.', 1)[1]} → {link['to']}")
                in_str = "; ".join(feeds_in) if feeds_in else "(no inputs linked)"
                out_str = "; ".join(feeds_out) if feeds_out else "(terminal)"
                print(f"    [{node_name}] {info['type']}")
                print(f"      IN:  {in_str}")
                print(f"      OUT: {out_str}")
                params = info.get("params", {})
                relevant = {k:v for k,v in params.items() if k not in ("Normal","Tangent","Clearcoat Normal","Displacement","Weight") or (isinstance(v, list) and v != [0,0,0]) or (not isinstance(v, list) and v != 0.0)}
                if relevant:
                    print(f"      PARAMS: {relevant}")
                if "stops" in info:
                    print(f"      STOPS: {info['stops']}")
                if "operation" in info:
                    print(f"      OP: {info['operation']}")
                if "blend_type" in info:
                    print(f"      BLEND: {info['blend_type']}")
                if "interpolation" in info:
                    print(f"      INTERP: {info['interpolation']}")

    print("\n\n")
