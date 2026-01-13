# Terrain Pipeline (USGS 3DEP)

This pipeline downloads USGS DEM tiles and builds a local heightmap
for sampling elevations in Stephentown.

## Prereqs

- Python 3.10+
- Packages available in this repo environment: `numpy`, `tifffile`, `requests`

## Step 1: Download DEM tiles

```bash
python scripts/terrain/fetch_usgs_dem.py --lat 42.5513326 --lon -73.3792285 --radius-miles 5 --out-dir data/terrain/usgs
```

Default dataset: `National Elevation Dataset (NED) 1/3 arc-second`

## Step 2: Build heightmap

```bash
python scripts/terrain/build_heightmap.py --input-dir data/terrain/usgs --center-lat 42.5513326 --center-lon -73.3792285 --radius-miles 5 --out-prefix data/terrain/stephentown_dem
```

Outputs:
- `data/terrain/stephentown_dem.bin` (Float32 row-major grid)
- `data/terrain/stephentown_dem.json` (metadata)

## Step 3: Seed with elevation

`prisma/seed.ts` uses `ElevationService` to read the heightmap and set
`positionZ` for seeded entities. If the heightmap is missing, elevation
falls back to `0`.

## Notes

- The heightmap uses an equirectangular projection and assumes WGS84
  lat/lon in the DEM tiles.
- For higher fidelity, switch to USGS 1-meter DEMs when available.
