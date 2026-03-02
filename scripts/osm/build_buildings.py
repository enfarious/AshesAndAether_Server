"""
Build 3D building meshes from OSM building footprints.

Extrudes building polygons to estimated heights and exports as GLB.

Usage:
    python scripts/osm/build_buildings.py \
        --input data/osm/stephentown/buildings.json \
        --origin-lat 42.5513326 --origin-lon -73.3792285 \
        --heightmap data/terrain/stephentown_dem \
        --output data/world/assets/USA_NY_Stephentown/stephentown_buildings.glb
"""

import argparse
import json
import math
from pathlib import Path
from typing import List, Optional, Tuple

import numpy as np
import trimesh
from shapely.geometry import Polygon as ShapelyPolygon
from shapely.validation import make_valid

# Earth radius in meters for coordinate conversion
EARTH_RADIUS = 6378137.0
METERS_TO_FEET = 3.28084

# Default building heights by type (in feet)
DEFAULT_HEIGHTS = {
    "house": 25,
    "residential": 30,
    "apartments": 45,
    "commercial": 35,
    "retail": 20,
    "industrial": 40,
    "warehouse": 30,
    "garage": 12,
    "shed": 10,
    "barn": 35,
    "church": 50,
    "school": 35,
    "hospital": 60,
    "yes": 25,  # Generic building tag
}

DEFAULT_HEIGHT = 25  # feet


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
        """Get elevation in feet at lat/lon. Returns None if out of bounds or no heightmap."""
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
    """
    Convert lat/lon to local feet coordinates relative to origin.
    X = East, Z = North (Y is up in the game world).
    """
    lat_rad = math.radians(lat)
    origin_lat_rad = math.radians(origin_lat)

    # Meters per degree
    meters_per_deg_lat = (math.pi / 180.0) * EARTH_RADIUS
    meters_per_deg_lon = (math.pi / 180.0) * EARTH_RADIUS * math.cos(origin_lat_rad)

    dx_meters = (lon - origin_lon) * meters_per_deg_lon
    dz_meters = (lat - origin_lat) * meters_per_deg_lat

    return dx_meters * METERS_TO_FEET, dz_meters * METERS_TO_FEET


def get_building_height(tags: dict) -> float:
    """Estimate building height from OSM tags."""
    # Explicit height tag (usually in meters)
    if "height" in tags:
        try:
            h = tags["height"]
            if isinstance(h, str):
                h = h.replace("m", "").replace("'", "").strip()
            return float(h) * METERS_TO_FEET
        except (ValueError, TypeError):
            pass

    # Building levels
    if "building:levels" in tags:
        try:
            levels = int(tags["building:levels"])
            return levels * 10  # ~10 feet per level
        except (ValueError, TypeError):
            pass

    # Building type
    building_type = tags.get("building", "yes")
    return DEFAULT_HEIGHTS.get(building_type, DEFAULT_HEIGHT)


def polygon_to_mesh(
    nodes: List[dict],
    height: float,
    base_elevation: float,
    origin_lat: float,
    origin_lon: float,
) -> Optional[trimesh.Trimesh]:
    """
    Extrude a polygon footprint into a 3D mesh.
    Returns None if polygon is invalid.
    """
    if len(nodes) < 3:
        return None

    # Convert nodes to local coordinates
    points_2d = []
    for node in nodes:
        x, z = latlon_to_local(node["lat"], node["lon"], origin_lat, origin_lon)
        points_2d.append((x, z))

    # Create shapely polygon (auto-closes)
    try:
        polygon = ShapelyPolygon(points_2d)

        # Fix invalid polygons (self-intersections, etc.)
        if not polygon.is_valid:
            polygon = make_valid(polygon)
            # make_valid can return GeometryCollection, extract polygon
            if polygon.geom_type == 'GeometryCollection':
                polygons = [g for g in polygon.geoms if g.geom_type == 'Polygon']
                if not polygons:
                    return None
                polygon = max(polygons, key=lambda p: p.area)
            elif polygon.geom_type != 'Polygon':
                return None

        if polygon.area < 10.0:  # Skip tiny buildings (< 10 sq ft)
            return None

    except Exception:
        return None

    # Extrude polygon using trimesh
    try:
        mesh = trimesh.creation.extrude_polygon(polygon, height)

        # Rotate so Z becomes Y (up) - trimesh extrudes along Z
        rotation = trimesh.transformations.rotation_matrix(
            -math.pi / 2, [1, 0, 0]
        )
        mesh.apply_transform(rotation)

        # Translate to base elevation
        mesh.apply_translation([0, base_elevation, 0])

        return mesh
    except Exception as e:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build 3D building meshes from OSM data."
    )
    parser.add_argument(
        "--input", type=str, required=True, help="Path to buildings.json"
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

    # Load buildings
    with open(args.input, "r", encoding="utf-8") as f:
        buildings = json.load(f)

    print(f"Processing {len(buildings)} buildings...")

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

    for building in buildings:
        nodes = building.get("nodes", [])
        tags = building.get("tags", {})

        if len(nodes) < 3:
            skipped += 1
            continue

        # Get building height
        height = get_building_height(tags)

        # Get base elevation (sample heightmap at building centroid)
        centroid_lat = sum(n["lat"] for n in nodes) / len(nodes)
        centroid_lon = sum(n["lon"] for n in nodes) / len(nodes)

        if heightmap:
            sampled = heightmap.sample(centroid_lat, centroid_lon)
            if sampled is None:
                # Building centroid is outside the DEM. Placing at default_elevation=0
                # (sea level) would bury the building ~265 m underground. Skip it.
                skipped += 1
                continue
            base_elevation = sampled
        else:
            base_elevation = args.default_elevation

        # Create mesh
        mesh = polygon_to_mesh(
            nodes, height, base_elevation, args.origin_lat, args.origin_lon
        )

        if mesh is not None:
            meshes.append(mesh)
        else:
            skipped += 1

    print(f"Created {len(meshes)} building meshes ({skipped} skipped)")

    if not meshes:
        print("No meshes to export!")
        return

    # Combine all meshes
    combined = trimesh.util.concatenate(meshes)

    # Export as GLB
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    combined.export(str(out_path), file_type="glb")
    print(f"Exported to {out_path}")

    # Print stats
    print(f"  Vertices: {len(combined.vertices)}")
    print(f"  Faces: {len(combined.faces)}")
    print(f"  Bounds: {combined.bounds}")


if __name__ == "__main__":
    main()
