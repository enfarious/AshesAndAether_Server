"""
Build 3D road meshes from OSM highway data.

Creates road strips with width based on highway type.

Usage:
    python scripts/osm/build_roads.py \
        --input data/osm/stephentown/roads.json \
        --origin-lat 42.5513326 --origin-lon -73.3792285 \
        --heightmap data/terrain/stephentown_dem \
        --output data/world/assets/USA_NY_Stephentown/stephentown_roads.glb
"""

import argparse
import json
import math
from pathlib import Path
from typing import List, Optional, Tuple

import numpy as np
import trimesh

# Earth radius in meters for coordinate conversion
EARTH_RADIUS = 6378137.0
METERS_TO_FEET = 3.28084

# Road widths by highway type (in feet)
ROAD_WIDTHS = {
    # Major roads
    "motorway": 48,
    "motorway_link": 24,
    "trunk": 40,
    "trunk_link": 20,
    "primary": 36,
    "primary_link": 18,
    "secondary": 30,
    "secondary_link": 15,
    "tertiary": 24,
    "tertiary_link": 12,

    # Minor roads
    "residential": 20,
    "unclassified": 18,
    "service": 12,
    "living_street": 16,

    # Paths
    "pedestrian": 10,
    "footway": 6,
    "path": 4,
    "cycleway": 8,
    "bridleway": 8,
    "steps": 6,
    "track": 10,

    # Other
    "road": 20,
}

DEFAULT_ROAD_WIDTH = 16  # feet

# Road surface offset above terrain (to prevent z-fighting)
ROAD_SURFACE_OFFSET = 0.1  # feet


class HeightmapSampler:
    """Sample elevation from a binary heightmap."""

    def __init__(self, prefix: str):
        meta_path = Path(prefix).with_suffix(".json")
        bin_path = Path(prefix).with_suffix(".bin")

        if not meta_path.exists() or not bin_path.exists():
            self.grid = None
            return

        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)

        self.origin_lat = meta["originLat"]
        self.origin_lon = meta["originLon"]
        self.pixel_size = meta["pixelSizeDeg"]
        self.width = meta["width"]
        self.height = meta["height"]

        self.grid = np.fromfile(bin_path, dtype=np.float32).reshape(
            (self.height, self.width)
        )

    def sample(self, lat: float, lon: float) -> Optional[float]:
        """Get elevation in feet at lat/lon. Returns None if out of bounds."""
        if self.grid is None:
            return None

        col = (lon - self.origin_lon) / self.pixel_size
        row = (self.origin_lat - lat) / self.pixel_size

        if col < 0 or col >= self.width - 1 or row < 0 or row >= self.height - 1:
            return None

        # Bilinear interpolation
        c0, c1 = int(col), int(col) + 1
        r0, r1 = int(row), int(row) + 1
        dc, dr = col - c0, row - r0

        v00 = self.grid[r0, c0]
        v01 = self.grid[r0, c1]
        v10 = self.grid[r1, c0]
        v11 = self.grid[r1, c1]

        v0 = v00 * (1 - dc) + v01 * dc
        v1 = v10 * (1 - dc) + v11 * dc
        elevation_meters = v0 * (1 - dr) + v1 * dr

        return elevation_meters * METERS_TO_FEET


def latlon_to_local(
    lat: float, lon: float, origin_lat: float, origin_lon: float
) -> Tuple[float, float]:
    """Convert lat/lon to local feet coordinates (X=East, Z=North)."""
    origin_lat_rad = math.radians(origin_lat)

    meters_per_deg_lat = (math.pi / 180.0) * EARTH_RADIUS
    meters_per_deg_lon = (math.pi / 180.0) * EARTH_RADIUS * math.cos(origin_lat_rad)

    dx_meters = (lon - origin_lon) * meters_per_deg_lon
    dz_meters = (lat - origin_lat) * meters_per_deg_lat

    return dx_meters * METERS_TO_FEET, dz_meters * METERS_TO_FEET


def get_road_width(tags: dict) -> float:
    """Get road width from OSM tags."""
    # Explicit width tag
    if "width" in tags:
        try:
            w = tags["width"]
            if isinstance(w, str):
                w = w.replace("m", "").replace("'", "").strip()
            return float(w) * METERS_TO_FEET
        except (ValueError, TypeError):
            pass

    # Lanes tag
    if "lanes" in tags:
        try:
            lanes = int(tags["lanes"])
            return lanes * 10  # ~10 feet per lane
        except (ValueError, TypeError):
            pass

    # Highway type
    highway_type = tags.get("highway", "road")
    return ROAD_WIDTHS.get(highway_type, DEFAULT_ROAD_WIDTH)


def road_to_mesh(
    nodes: List[dict],
    width: float,
    heightmap: Optional[HeightmapSampler],
    default_elevation: float,
    origin_lat: float,
    origin_lon: float,
) -> Optional[trimesh.Trimesh]:
    """
    Create a road strip mesh from a polyline.
    Returns None if road is invalid.
    """
    if len(nodes) < 2:
        return None

    # Convert nodes to local coordinates with elevations.
    # Only include nodes that have valid heightmap coverage — nodes outside the
    # DEM would fall back to default_elevation=0 (sea level), which creates road
    # geometry that dives hundreds of metres underground.
    points_3d = []
    for node in nodes:
        x, z = latlon_to_local(node["lat"], node["lon"], origin_lat, origin_lon)
        # latlon_to_local returns Z+ = North; game uses Z+ = South — negate.
        z = -z

        # Sample elevation — skip this node if it falls outside the DEM.
        if heightmap:
            sampled = heightmap.sample(node["lat"], node["lon"])
            if sampled is None:
                continue  # Node outside DEM bounds; don't place at sea level
            y = sampled
        else:
            y = default_elevation

        y += ROAD_SURFACE_OFFSET  # Offset above terrain
        points_3d.append([x, y, z])

    points_3d = np.array(points_3d)

    if len(points_3d) < 2:
        return None

    # Generate road strip geometry
    vertices = []
    faces = []
    half_width = width / 2

    for i in range(len(points_3d)):
        p = points_3d[i]

        # Calculate perpendicular direction
        if i == 0:
            direction = points_3d[i + 1] - p
        elif i == len(points_3d) - 1:
            direction = p - points_3d[i - 1]
        else:
            # Average of incoming and outgoing direction for smooth corners
            dir_in = p - points_3d[i - 1]
            dir_out = points_3d[i + 1] - p
            direction = (dir_in / np.linalg.norm(dir_in) + dir_out / np.linalg.norm(dir_out))

        # Normalize and get perpendicular (in XZ plane)
        direction[1] = 0  # Keep horizontal
        length = np.linalg.norm(direction)
        if length < 0.001:
            # Degenerate segment
            perp = np.array([1, 0, 0])
        else:
            direction = direction / length
            perp = np.array([-direction[2], 0, direction[0]])

        # Add left and right vertices
        left = p + perp * half_width
        right = p - perp * half_width
        vertices.append(left)
        vertices.append(right)

    vertices = np.array(vertices)

    # Create faces (quads as pairs of triangles).
    # Winding: after negating Z above, a single-axis reflection inverts the
    # winding order, which would make road normals point downward.
    # Swap the two non-pivot vertices in each triangle to restore upward normals.
    for i in range(len(points_3d) - 1):
        idx = i * 2
        # Quad from vertices: idx=left[i], idx+1=right[i], idx+2=left[i+1], idx+3=right[i+1]
        # Triangle 1: idx, idx+1, idx+2  (reversed from pre-Z-flip order)
        # Triangle 2: idx+1, idx+3, idx+2
        faces.append([idx, idx + 1, idx + 2])
        faces.append([idx + 1, idx + 3, idx + 2])

    if len(faces) == 0:
        return None

    faces = np.array(faces)

    mesh = trimesh.Trimesh(vertices=vertices, faces=faces)
    return mesh


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build 3D road meshes from OSM data."
    )
    parser.add_argument(
        "--input", type=str, required=True, help="Path to roads.json"
    )
    parser.add_argument(
        "--origin-lat", type=float, required=True, help="Origin latitude."
    )
    parser.add_argument(
        "--origin-lon", type=float, required=True, help="Origin longitude."
    )
    parser.add_argument(
        "--heightmap",
        type=str,
        default=None,
        help="Path prefix to heightmap (without extension).",
    )
    parser.add_argument(
        "--output",
        type=str,
        required=True,
        help="Output GLB file path.",
    )
    parser.add_argument(
        "--default-elevation",
        type=float,
        default=0.0,
        help="Default ground elevation in feet if no heightmap.",
    )
    args = parser.parse_args()

    # Load roads
    with open(args.input, "r", encoding="utf-8") as f:
        roads = json.load(f)

    print(f"Processing {len(roads)} roads...")

    # Load heightmap if available
    heightmap = None
    if args.heightmap:
        heightmap = HeightmapSampler(args.heightmap)
        if heightmap.grid is not None:
            print(f"Loaded heightmap: {heightmap.width}x{heightmap.height}")
        else:
            print("Warning: Could not load heightmap, using default elevation")

    meshes = []
    skipped = 0

    # Count by type
    type_counts = {}

    for road in roads:
        nodes = road.get("nodes", [])
        tags = road.get("tags", {})

        if len(nodes) < 2:
            skipped += 1
            continue

        highway_type = tags.get("highway", "road")
        type_counts[highway_type] = type_counts.get(highway_type, 0) + 1

        # Pre-filter: drop nodes outside the DEM so road_to_mesh never falls
        # back to default_elevation=0 (sea level) for out-of-bounds nodes.
        if heightmap and heightmap.grid is not None:
            nodes = [n for n in nodes if heightmap.sample(n["lat"], n["lon"]) is not None]
            if len(nodes) < 2:
                skipped += 1
                continue

        # Get road width
        width = get_road_width(tags)

        # Create mesh
        mesh = road_to_mesh(
            nodes, width, heightmap, args.default_elevation,
            args.origin_lat, args.origin_lon
        )

        if mesh is not None:
            meshes.append(mesh)
        else:
            skipped += 1

    print(f"Created {len(meshes)} road meshes ({skipped} skipped)")

    # Print type breakdown
    print("\nRoad types:")
    for road_type, count in sorted(type_counts.items(), key=lambda x: -x[1]):
        print(f"  {road_type}: {count}")

    if not meshes:
        print("No meshes to export!")
        return

    # Combine all meshes
    combined = trimesh.util.concatenate(meshes)

    # Export as GLB
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    combined.export(str(out_path), file_type="glb")
    print(f"\nExported to {out_path}")

    # Print stats
    print(f"  Vertices: {len(combined.vertices)}")
    print(f"  Faces: {len(combined.faces)}")
    print(f"  Bounds: {combined.bounds}")


if __name__ == "__main__":
    main()
