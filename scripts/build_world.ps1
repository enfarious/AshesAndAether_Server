# Build world assets for a zone
# Usage: .\scripts\build_world.ps1 [-ZoneId "USA_NY_Stephentown"] [-SkipTerrain] [-SkipOSM] [-SkipTerrainMesh]

param(
    [string]$ZoneId = "USA_NY_Stephentown",
    [float]$Lat = 42.5513326,
    [float]$Lon = -73.3792285,
    [float]$RadiusMiles = 2.0,
    [switch]$SkipTerrain,
    [switch]$SkipOSM,
    [switch]$SkipTerrainMesh,
    [int]$TerrainDownsample = 2,
    [int]$TerrainChunkSize = 0
)

$ErrorActionPreference = "Stop"

$DataDir = "data"
$TerrainDir = "$DataDir/terrain"
$OSMDir = "$DataDir/osm/$ZoneId"
$AssetsDir = "$DataDir/world/assets/$ZoneId"

Write-Host "Building world assets for $ZoneId" -ForegroundColor Cyan
Write-Host "  Center: ($Lat, $Lon)"
Write-Host "  Radius: $RadiusMiles miles"
Write-Host ""

# Create directories
New-Item -ItemType Directory -Force -Path $TerrainDir | Out-Null
New-Item -ItemType Directory -Force -Path $OSMDir | Out-Null
New-Item -ItemType Directory -Force -Path $AssetsDir | Out-Null

# Step 1: Fetch USGS DEM tiles
if (-not $SkipTerrain) {
    Write-Host "=== Step 1: Fetching USGS elevation data ===" -ForegroundColor Yellow
    python scripts/terrain/fetch_usgs_dem.py `
        --lat $Lat --lon $Lon `
        --radius-miles ($RadiusMiles + 1) `
        --out-dir "$TerrainDir/usgs"

    Write-Host ""
    Write-Host "=== Step 2: Building heightmap ===" -ForegroundColor Yellow
    $HeightmapPrefix = "$TerrainDir/$($ZoneId.ToLower())_dem"
    python scripts/terrain/build_heightmap.py `
        --input-dir "$TerrainDir/usgs" `
        --center-lat $Lat --center-lon $Lon `
        --radius-miles $RadiusMiles `
        --out-prefix $HeightmapPrefix
} else {
    Write-Host "=== Skipping terrain (--SkipTerrain) ===" -ForegroundColor DarkGray
    $HeightmapPrefix = "$TerrainDir/$($ZoneId.ToLower())_dem"
}

# Step 2.5: Build terrain mesh
if (-not $SkipTerrainMesh) {
    Write-Host ""
    Write-Host "=== Step 2.5: Building terrain mesh ===" -ForegroundColor Yellow

    $TerrainMeshArgs = @(
        "scripts/terrain/build_terrain_mesh.py",
        "--heightmap", $HeightmapPrefix,
        "--origin-lat", $Lat,
        "--origin-lon", $Lon
    )

    if ($TerrainChunkSize -gt 0) {
        $TerrainMeshArgs += "--output", "$AssetsDir/terrain"
        $TerrainMeshArgs += "--chunk-size", $TerrainChunkSize
    } else {
        $TerrainMeshArgs += "--output", "$AssetsDir/$($ZoneId.ToLower())_terrain.glb"
    }

    if ($TerrainDownsample -gt 1) {
        $TerrainMeshArgs += "--downsample", $TerrainDownsample
    }

    python @TerrainMeshArgs
} else {
    Write-Host "=== Skipping terrain mesh (--SkipTerrainMesh) ===" -ForegroundColor DarkGray
}

# Step 3: Fetch OSM data
if (-not $SkipOSM) {
    Write-Host ""
    Write-Host "=== Step 3: Fetching OSM data ===" -ForegroundColor Yellow
    python scripts/osm/fetch_osm.py `
        --lat $Lat --lon $Lon `
        --radius-miles $RadiusMiles `
        --out-dir $OSMDir

    # Step 4: Build building meshes
    Write-Host ""
    Write-Host "=== Step 4: Building building meshes ===" -ForegroundColor Yellow
    python scripts/osm/build_buildings.py `
        --input "$OSMDir/buildings.json" `
        --origin-lat $Lat --origin-lon $Lon `
        --heightmap $HeightmapPrefix `
        --output "$AssetsDir/$($ZoneId.ToLower())_buildings.glb"

    # Step 5: Build road meshes
    Write-Host ""
    Write-Host "=== Step 5: Building road meshes ===" -ForegroundColor Yellow
    python scripts/osm/build_roads.py `
        --input "$OSMDir/roads.json" `
        --origin-lat $Lat --origin-lon $Lon `
        --heightmap $HeightmapPrefix `
        --output "$AssetsDir/$($ZoneId.ToLower())_roads.glb"
} else {
    Write-Host "=== Skipping OSM (--SkipOSM) ===" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "=== Build complete ===" -ForegroundColor Green
Write-Host "Assets generated in: $AssetsDir"
Write-Host ""
Write-Host "Files:"
Get-ChildItem -Path $AssetsDir -File -ErrorAction SilentlyContinue | ForEach-Object {
    $size = if ($_.Length -gt 1MB) { "{0:N2} MB" -f ($_.Length / 1MB) } else { "{0:N2} KB" -f ($_.Length / 1KB) }
    Write-Host "  $($_.Name): $size"
}
# List chunked terrain if present
if (Test-Path "$AssetsDir/terrain") {
    Write-Host ""
    Write-Host "Terrain chunks:"
    Get-ChildItem -Path "$AssetsDir/terrain" -File | ForEach-Object {
        $size = if ($_.Length -gt 1MB) { "{0:N2} MB" -f ($_.Length / 1MB) } else { "{0:N2} KB" -f ($_.Length / 1KB) }
        Write-Host "  terrain/$($_.Name): $size"
    }
}
