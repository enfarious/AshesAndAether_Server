# Build terrain assets (USGS 3DEP -> merged heightmap)

param(
    [double]$CenterLat = 42.5513326,
    [double]$CenterLon = -73.3792285,
    [double]$RadiusMiles = 5,
    [string]$TilesDir = "data/terrain/usgs",
    [string]$OutputPrefix = "data/terrain/stephentown_dem"
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Ashes & Aether - Build Terrain" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Center: $CenterLat, $CenterLon" -ForegroundColor Gray
Write-Host "Radius: $RadiusMiles miles" -ForegroundColor Gray
Write-Host "Tiles:  $TilesDir" -ForegroundColor Gray
Write-Host "Output: $OutputPrefix" -ForegroundColor Gray
Write-Host "========================================`n" -ForegroundColor Cyan

python scripts/terrain/fetch_usgs_dem.py `
    --lat $CenterLat `
    --lon $CenterLon `
    --radius-miles $RadiusMiles `
    --out-dir $TilesDir

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

python scripts/terrain/build_heightmap.py `
    --input-dir $TilesDir `
    --center-lat $CenterLat `
    --center-lon $CenterLon `
    --radius-miles $RadiusMiles `
    --out-prefix $OutputPrefix

exit $LASTEXITCODE
