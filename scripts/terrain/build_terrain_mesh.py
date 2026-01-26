"""
Build 3D terrain mesh from heightmap data.

Creates a terrain surface mesh from USGS DEM heightmap.

Usage:
    python scripts/terrain/build_terrain_mesh.py \
        --heightmap data/terrain/stephentown_dem \
        --origin-lat 42.5513326 --origin-lon -73.3792285 \
        --output data/world/assets/USA_NY_Stephentown/stephentown_terrain.glb

Options:
    --downsample N    Reduce resolution by factor N (default: 1, no downsampling)
    --chunk-size N    Split terrain into NxN chunks for streaming (default: 0, no chunking)
"""

import argparse
import json
import math
from pathlib import Path
from typing import Optional, Tuple

import numpy as np
import trimesh

# Earth radius in meters for coordinate conversion
EARTH_RADIUS = 6378137.0
METERS_TO_FEET = 3.28084


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


def load_heightmap(prefix: str) -> Tuple[np.ndarray, dict]:
    """Load heightmap binary and metadata."""
    meta_path = Path(prefix).with_suffix(".json")
    bin_path = Path(prefix).with_suffix(".bin")

    if not meta_path.exists():
        raise FileNotFoundError(f"Heightmap metadata not found: {meta_path}")
    if not bin_path.exists():
        raise FileNotFoundError(f"Heightmap binary not found: {bin_path}")

    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)

    width = meta["width"]
    height = meta["height"]

    grid = np.fromfile(bin_path, dtype=np.float32).reshape((height, width))

    return grid, meta


def create_terrain_mesh(
    grid: np.ndarray,
    meta: dict,
    origin_lat: float,
    origin_lon: float,
    downsample: int = 1,
) -> trimesh.Trimesh:
    """Create a terrain mesh from heightmap data."""
    # Downsample if requested
    if downsample > 1:
        grid = grid[::downsample, ::downsample]

    height, width = grid.shape
    pixel_size = meta["pixelSizeDeg"] * downsample
    hmap_origin_lat = meta["originLat"]
    hmap_origin_lon = meta["originLon"]

    print(f"  Grid size: {width}x{height} = {width * height:,} vertices")

    # Create vertex grid
    vertices = []
    for row in range(height):
        for col in range(width):
            # Calculate lat/lon for this pixel
            lon = hmap_origin_lon + col * pixel_size
            lat = hmap_origin_lat - row * pixel_size

            # Convert to local coordinates
            x, z = latlon_to_local(lat, lon, origin_lat, origin_lon)

            # Elevation in feet (heightmap is in meters)
            y = grid[row, col] * METERS_TO_FEET

            # Handle nodata values
            if np.isnan(y) or y < -1000:
                y = 0.0

            vertices.append([x, y, z])

    vertices = np.array(vertices, dtype=np.float32)

    # Create faces (two triangles per quad)
    faces = []
    for row in range(height - 1):
        for col in range(width - 1):
            # Vertex indices for this quad
            v00 = row * width + col
            v01 = row * width + col + 1
            v10 = (row + 1) * width + col
            v11 = (row + 1) * width + col + 1

            # Two triangles (counter-clockwise winding)
            faces.append([v00, v10, v01])
            faces.append([v01, v10, v11])

    faces = np.array(faces, dtype=np.int32)

    print(f"  Faces: {len(faces):,}")

    # Create mesh
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces)

    # Generate vertex normals for smooth shading
    mesh.fix_normals()

    return mesh


def create_chunked_terrain(
    grid: np.ndarray,
    meta: dict,
    origin_lat: float,
    origin_lon: float,
    chunk_size: int,
    downsample: int = 1,
    output_dir: Path = None,
    output_prefix: str = "terrain",
) -> dict:
    """Create terrain split into chunks for streaming."""
    if downsample > 1:
        grid = grid[::downsample, ::downsample]

    height, width = grid.shape
    pixel_size = meta["pixelSizeDeg"] * downsample

    chunks_x = math.ceil(width / chunk_size)
    chunks_z = math.ceil(height / chunk_size)

    print(f"  Creating {chunks_x}x{chunks_z} = {chunks_x * chunks_z} chunks")

    manifest = {
        "chunks_x": chunks_x,
        "chunks_z": chunks_z,
        "chunk_size": chunk_size,
        "origin_lat": origin_lat,
        "origin_lon": origin_lon,
        "files": [],
    }

    for chunk_row in range(chunks_z):
        for chunk_col in range(chunks_x):
            # Extract chunk from grid
            row_start = chunk_row * chunk_size
            row_end = min(row_start + chunk_size + 1, height)  # +1 for overlap
            col_start = chunk_col * chunk_size
            col_end = min(col_start + chunk_size + 1, width)

            chunk_grid = grid[row_start:row_end, col_start:col_end]

            # Adjust metadata for this chunk
            chunk_meta = meta.copy()
            chunk_meta["originLat"] = meta["originLat"] - row_start * pixel_size
            chunk_meta["originLon"] = meta["originLon"] + col_start * pixel_size
            chunk_meta["width"] = chunk_grid.shape[1]
            chunk_meta["height"] = chunk_grid.shape[0]

            # Create mesh for this chunk
            mesh = create_terrain_mesh(
                chunk_grid, chunk_meta, origin_lat, origin_lon, downsample=1
            )

            # Save chunk
            chunk_name = f"{output_prefix}_chunk_{chunk_col}_{chunk_row}.glb"
            chunk_path = output_dir / chunk_name
            mesh.export(chunk_path)

            # Calculate chunk bounds in local coordinates
            min_lon = meta["originLon"] + col_start * pixel_size
            max_lon = meta["originLon"] + (col_end - 1) * pixel_size
            max_lat = meta["originLat"] - row_start * pixel_size
            min_lat = meta["originLat"] - (row_end - 1) * pixel_size

            min_x, min_z = latlon_to_local(min_lat, min_lon, origin_lat, origin_lon)
            max_x, max_z = latlon_to_local(max_lat, max_lon, origin_lat, origin_lon)

            manifest["files"].append({
                "file": chunk_name,
                "chunk_x": chunk_col,
                "chunk_z": chunk_row,
                "bounds": {
                    "min_x": min(min_x, max_x),
                    "max_x": max(min_x, max_x),
                    "min_z": min(min_z, max_z),
                    "max_z": max(min_z, max_z),
                },
            })

            print(f"    Chunk ({chunk_col}, {chunk_row}): {chunk_path.name}")

    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build terrain mesh from USGS DEM heightmap."
    )
    parser.add_argument(
        "--heightmap",
        type=str,
        required=True,
        help="Heightmap prefix (path without .bin/.json extension)",
    )
    parser.add_argument(
        "--origin-lat",
        type=float,
        required=True,
        help="Origin latitude (game world origin)",
    )
    parser.add_argument(
        "--origin-lon",
        type=float,
        required=True,
        help="Origin longitude (game world origin)",
    )
    parser.add_argument(
        "--output",
        type=str,
        required=True,
        help="Output GLB path (or directory if chunking)",
    )
    parser.add_argument(
        "--downsample",
        type=int,
        default=1,
        help="Downsample factor (1=full res, 2=half res, etc.)",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=0,
        help="Chunk size in pixels (0=no chunking)",
    )
    args = parser.parse_args()

    print(f"Loading heightmap from {args.heightmap}...")
    grid, meta = load_heightmap(args.heightmap)
    print(f"  Original size: {meta['width']}x{meta['height']}")

    if args.chunk_size > 0:
        # Chunked output
        output_dir = Path(args.output)
        output_dir.mkdir(parents=True, exist_ok=True)

        print(f"Creating chunked terrain (chunk size: {args.chunk_size})...")
        manifest = create_chunked_terrain(
            grid,
            meta,
            args.origin_lat,
            args.origin_lon,
            args.chunk_size,
            args.downsample,
            output_dir,
            "terrain",
        )

        manifest_path = output_dir / "terrain_manifest.json"
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)

        print(f"\nChunked terrain saved to {output_dir}")
        print(f"Manifest: {manifest_path}")
    else:
        # Single mesh output
        print("Creating terrain mesh...")
        mesh = create_terrain_mesh(
            grid, meta, args.origin_lat, args.origin_lon, args.downsample
        )

        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        mesh.export(output_path)

        size_mb = output_path.stat().st_size / (1024 * 1024)
        print(f"\nTerrain mesh saved to {output_path} ({size_mb:.2f} MB)")


if __name__ == "__main__":
    main()
