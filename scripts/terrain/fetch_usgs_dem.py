import argparse
import json
import math
import os
from pathlib import Path
from typing import Dict, List

import requests


DEFAULT_DATASET = "National Elevation Dataset (NED) 1/3 arc-second"
TNM_PRODUCTS_URL = "https://tnmaccess.nationalmap.gov/api/v1/products"


def miles_to_degrees_lat(miles: float) -> float:
    return miles / 69.0


def miles_to_degrees_lon(miles: float, lat: float) -> float:
    return miles / (69.0 * math.cos(math.radians(lat)))


def build_bbox(lat: float, lon: float, radius_miles: float) -> str:
    dlat = miles_to_degrees_lat(radius_miles)
    dlon = miles_to_degrees_lon(radius_miles, lat)
    min_lat = lat - dlat
    max_lat = lat + dlat
    min_lon = lon - dlon
    max_lon = lon + dlon
    return f"{min_lon},{min_lat},{max_lon},{max_lat}"


def fetch_items(dataset: str, bbox: str, max_items: int = 200) -> List[Dict]:
    items: List[Dict] = []
    offset = 0

    while True:
        params = {
            "datasets": dataset,
            "bbox": bbox,
            "max": max_items,
            "offset": offset,
        }
        resp = requests.get(TNM_PRODUCTS_URL, params=params, timeout=60)
        resp.raise_for_status()
        payload = resp.json()
        batch = payload.get("items", [])
        if not batch:
            break
        items.extend(batch)
        offset += len(batch)
        if len(batch) < max_items:
            break

    return items


def sanitize_filename(name: str) -> str:
    cleaned = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in name)
    return cleaned.strip("_")


def download_file(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        return
    with requests.get(url, stream=True, timeout=120) as resp:
        resp.raise_for_status()
        with open(dest, "wb") as handle:
            for chunk in resp.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    handle.write(chunk)


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch USGS DEM tiles for a given area.")
    parser.add_argument("--lat", type=float, required=True, help="Center latitude.")
    parser.add_argument("--lon", type=float, required=True, help="Center longitude.")
    parser.add_argument("--radius-miles", type=float, default=5.0, help="Radius in miles.")
    parser.add_argument("--dataset", type=str, default=DEFAULT_DATASET, help="USGS dataset name.")
    parser.add_argument("--out-dir", type=str, default="data/terrain/usgs", help="Output directory.")
    args = parser.parse_args()

    bbox = build_bbox(args.lat, args.lon, args.radius_miles)
    items = fetch_items(args.dataset, bbox)
    out_dir = Path(args.out_dir)

    downloads = []
    for item in items:
        url = item.get("downloadURL")
        title = item.get("title", "usgs_dem")
        if not url or not url.lower().endswith((".tif", ".tiff")):
            continue
        filename = sanitize_filename(title) + ".tif"
        dest = out_dir / filename
        download_file(url, dest)
        downloads.append(
            {
                "title": title,
                "url": url,
                "path": str(dest.as_posix()),
                "format": item.get("format"),
                "boundingBox": item.get("boundingBox"),
            }
        )

    index = {
        "dataset": args.dataset,
        "center": {"lat": args.lat, "lon": args.lon, "radiusMiles": args.radius_miles},
        "bbox": bbox,
        "downloads": downloads,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_dir / "index.json", "w", encoding="utf-8") as handle:
        json.dump(index, handle, indent=2)

    print(f"Downloaded {len(downloads)} tiles to {out_dir}")


if __name__ == "__main__":
    main()
