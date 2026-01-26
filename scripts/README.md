# World Generation Scripts

Scripts for generating 3D world assets from real-world data (USGS elevation + OpenStreetMap).

## Setup

```bash
# Install Python dependencies
pip install -r scripts/requirements.txt
```

### Dependencies

| Package | Purpose |
|---------|---------|
| `requests` | HTTP requests for USGS/OSM APIs |
| `numpy` | Numerical operations |
| `tifffile` | Reading GeoTIFF elevation data |
| `imagecodecs` | LZW compression support for GeoTIFFs |
| `trimesh` | 3D mesh generation and GLB export |
| `shapely` | Polygon validation and operations |
| `mapbox-earcut` | Polygon triangulation for building meshes |

## Quick Start

Generate all assets for a zone:

```powershell
# Stephentown, NY (default)
.\scripts\build_world.ps1

# Jiminy Peak, MA
.\scripts\build_world.ps1 -ZoneId "USA_MA_JiminyPeak" -Lat 42.4995 -Lon -73.2843 -RadiusMiles 1.5

# Custom location
.\scripts\build_world.ps1 -ZoneId "MyZone" -Lat <latitude> -Lon <longitude> -RadiusMiles <radius>
```

## Pipeline Steps

The build script runs these steps in order:

### 1. Fetch USGS Elevation Data
```bash
python scripts/terrain/fetch_usgs_dem.py \
    --lat 42.5513326 --lon -73.3792285 \
    --radius-miles 3 \
    --out-dir data/terrain/usgs
```
Downloads GeoTIFF elevation tiles from USGS The National Map API.

### 2. Build Heightmap
```bash
python scripts/terrain/build_heightmap.py \
    --input-dir data/terrain/usgs \
    --center-lat 42.5513326 --center-lon -73.3792285 \
    --radius-miles 2 \
    --out-prefix data/terrain/myzone_dem
```
Merges tiles into a single heightmap (`.bin` + `.json` metadata).

### 3. Build Terrain Mesh
```bash
python scripts/terrain/build_terrain_mesh.py \
    --heightmap data/terrain/myzone_dem \
    --origin-lat 42.5513326 --origin-lon -73.3792285 \
    --output data/world/assets/MyZone/myzone_terrain.glb \
    --downsample 2
```
Converts heightmap to 3D terrain mesh.

Options:
- `--downsample N`: Reduce resolution by factor N (2 = half, 4 = quarter)
- `--chunk-size N`: Split into NxN streaming chunks

### 4. Fetch OSM Data
```bash
python scripts/osm/fetch_osm.py \
    --lat 42.5513326 --lon -73.3792285 \
    --radius-miles 2 \
    --out-dir data/osm/MyZone
```
Fetches buildings, roads, and features from OpenStreetMap Overpass API.

### 5. Build Building Meshes
```bash
python scripts/osm/build_buildings.py \
    --input data/osm/MyZone/buildings.json \
    --origin-lat 42.5513326 --origin-lon -73.3792285 \
    --heightmap data/terrain/myzone_dem \
    --output data/world/assets/MyZone/myzone_buildings.glb
```
Extrudes 2D building footprints to 3D models with estimated heights.

### 6. Build Road Meshes
```bash
python scripts/osm/build_roads.py \
    --input data/osm/MyZone/roads.json \
    --origin-lat 42.5513326 --origin-lon -73.3792285 \
    --heightmap data/terrain/myzone_dem \
    --output data/world/assets/MyZone/myzone_roads.glb
```
Creates road strips following terrain elevation.

## Output Structure

```
data/
├── terrain/
│   ├── usgs/                    # Downloaded GeoTIFF tiles
│   ├── myzone_dem.bin           # Binary heightmap (float32, meters)
│   └── myzone_dem.json          # Heightmap metadata
├── osm/
│   └── MyZone/
│       ├── buildings.json       # OSM building data
│       ├── roads.json           # OSM road data
│       └── ...                  # Other OSM features
└── world/
    └── assets/
        └── MyZone/
            ├── myzone_terrain.glb    # Terrain mesh
            ├── myzone_buildings.glb  # Building meshes
            └── myzone_roads.glb      # Road meshes
```

## Coordinate System

All assets use a local coordinate system in **feet**:
- **X**: East (positive) / West (negative)
- **Y**: Up (elevation)
- **Z**: North (positive) / South (negative)
- **Origin**: Specified by `--origin-lat` and `--origin-lon`

## Build Options

```powershell
.\scripts\build_world.ps1 `
    -ZoneId "MyZone" `
    -Lat 42.5513326 `
    -Lon -73.3792285 `
    -RadiusMiles 2.0 `
    -SkipTerrain `           # Skip USGS fetch + heightmap (use existing)
    -SkipOSM `               # Skip OSM fetch + building/road meshes
    -SkipTerrainMesh `       # Skip terrain mesh generation
    -TerrainDownsample 2 `   # Terrain resolution (1=full, 2=half, etc.)
    -TerrainChunkSize 256    # Split terrain into streaming chunks
```

## Troubleshooting

### "imagecodecs" errors
Some USGS tiles use LZW compression. Install: `pip install imagecodecs`

### Buildings all skipped (0 created)
Polygon triangulation needs mapbox-earcut: `pip install mapbox-earcut`

### API rate limits
- USGS: Generally permissive, but large areas may timeout
- OSM Overpass: Has rate limits; the script includes retry logic

### Large terrain files
Use `--downsample` to reduce resolution, or `--chunk-size` to split into streaming chunks for the client.
