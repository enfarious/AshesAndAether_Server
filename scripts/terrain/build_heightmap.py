import argparse
import json
import math
from pathlib import Path
from typing import List, Tuple

import numpy as np
import tifffile


FEET_PER_METER = 3.28084


class Tile:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.data = None
        self.origin_lon = None
        self.origin_lat = None
        self.scale_lon = None
        self.scale_lat = None

    def load(self) -> None:
        with tifffile.TiffFile(self.path) as tif:
            page = tif.pages[0]
            data = page.asarray()
            tags = page.tags

        scale_tag = tags.get("ModelPixelScaleTag")
        tiepoint_tag = tags.get("ModelTiepointTag")
        if scale_tag is None or tiepoint_tag is None:
            raise ValueError(f"Missing GeoTIFF tags in {self.path}")

        scale = scale_tag.value
        tie = tiepoint_tag.value

        # GeoTIFF tiepoint: (i, j, k, x, y, z)
        self.origin_lon = float(tie[3])
        self.origin_lat = float(tie[4])
        self.scale_lon = float(scale[0])
        self.scale_lat = float(scale[1])

        self.data = data.astype(np.float32)

    def bounds(self) -> Tuple[float, float, float, float]:
        if self.data is None:
            raise ValueError("Tile not loaded")
        height, width = self.data.shape
        min_lon = self.origin_lon
        max_lon = self.origin_lon + width * self.scale_lon
        max_lat = self.origin_lat
        min_lat = self.origin_lat - height * self.scale_lat
        return min_lon, min_lat, max_lon, max_lat


def load_tiles(paths: List[Path]) -> List[Tile]:
    tiles = []
    for path in paths:
        tile = Tile(path)
        tile.load()
        tiles.append(tile)
    return tiles


def compute_union_bounds(tiles: List[Tile]) -> Tuple[float, float, float, float]:
    min_lon = min(t.bounds()[0] for t in tiles)
    min_lat = min(t.bounds()[1] for t in tiles)
    max_lon = max(t.bounds()[2] for t in tiles)
    max_lat = max(t.bounds()[3] for t in tiles)
    return min_lon, min_lat, max_lon, max_lat


def clamp_bounds(
    bounds: Tuple[float, float, float, float],
    center_lat: float,
    center_lon: float,
    radius_miles: float,
) -> Tuple[float, float, float, float]:
    dlat = radius_miles / 69.0
    dlon = radius_miles / (69.0 * math.cos(math.radians(center_lat)))
    min_lon = max(bounds[0], center_lon - dlon)
    max_lon = min(bounds[2], center_lon + dlon)
    min_lat = max(bounds[1], center_lat - dlat)
    max_lat = min(bounds[3], center_lat + dlat)
    return min_lon, min_lat, max_lon, max_lat


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a merged heightmap from USGS DEM tiles.")
    parser.add_argument("--input-dir", type=str, required=True, help="Directory with GeoTIFF tiles.")
    parser.add_argument("--center-lat", type=float, required=True, help="Center latitude.")
    parser.add_argument("--center-lon", type=float, required=True, help="Center longitude.")
    parser.add_argument("--radius-miles", type=float, default=5.0, help="Radius in miles.")
    parser.add_argument("--out-prefix", type=str, default="data/terrain/stephentown_dem", help="Output prefix path.")
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    tiff_paths = sorted(list(input_dir.glob("*.tif")))
    if not tiff_paths:
        raise SystemExit(f"No GeoTIFF tiles found in {input_dir}")

    tiles = load_tiles(tiff_paths)
    min_lon, min_lat, max_lon, max_lat = compute_union_bounds(tiles)
    min_lon, min_lat, max_lon, max_lat = clamp_bounds(
        (min_lon, min_lat, max_lon, max_lat),
        args.center_lat,
        args.center_lon,
        args.radius_miles,
    )

    scale_lon = tiles[0].scale_lon
    scale_lat = tiles[0].scale_lat

    width = int(math.ceil((max_lon - min_lon) / scale_lon))
    height = int(math.ceil((max_lat - min_lat) / scale_lat))
    nodata = np.nan
    grid = np.full((height, width), nodata, dtype=np.float32)

    for tile in tiles:
        tile_min_lon, tile_min_lat, tile_max_lon, tile_max_lat = tile.bounds()

        # Skip tiles outside clip bounds
        if tile_max_lon < min_lon or tile_min_lon > max_lon:
            continue
        if tile_max_lat < min_lat or tile_min_lat > max_lat:
            continue

        origin_col = int(round((tile.origin_lon - min_lon) / scale_lon))
        origin_row = int(round((max_lat - tile.origin_lat) / scale_lat))

        tile_data = tile.data
        tile_height, tile_width = tile_data.shape

        row_start = max(0, origin_row)
        col_start = max(0, origin_col)
        row_end = min(height, origin_row + tile_height)
        col_end = min(width, origin_col + tile_width)

        src_row_start = max(0, -origin_row)
        src_col_start = max(0, -origin_col)

        src_row_end = src_row_start + (row_end - row_start)
        src_col_end = src_col_start + (col_end - col_start)

        grid[row_start:row_end, col_start:col_end] = tile_data[src_row_start:src_row_end, src_col_start:src_col_end]

    out_prefix = Path(args.out_prefix)
    out_prefix.parent.mkdir(parents=True, exist_ok=True)

    bin_path = out_prefix.with_suffix(".bin")
    grid.tofile(bin_path)

    metadata = {
        "originLat": max_lat,
        "originLon": min_lon,
        "pixelSizeDeg": scale_lon,
        "width": width,
        "height": height,
        "units": "meters",
        "nodata": None,
        "center": {"lat": args.center_lat, "lon": args.center_lon, "radiusMiles": args.radius_miles},
    }

    meta_path = out_prefix.with_suffix(".json")
    with open(meta_path, "w", encoding="utf-8") as handle:
        json.dump(metadata, handle, indent=2)

    print(f"Wrote {bin_path} and {meta_path}")


if __name__ == "__main__":
    main()
