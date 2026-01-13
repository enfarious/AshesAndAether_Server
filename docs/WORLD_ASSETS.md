# World Assets Manifest

Clients download prebuilt world assets from the server and cache them locally.

## Endpoint

`GET /world/assets`

Returns a list of zone IDs with assets.

`GET /world/assets/:zoneId`

Returns the manifest for a specific zone ID. Responses include an `ETag`
header. Clients should cache the manifest and revalidate with
`If-None-Match`.

## Example Manifest

```json
{
  "version": "0.1.0",
  "worldId": "USA_NY_Stephentown",
  "projection": "equirectangular",
  "origin": {
    "lat": 42.5513326,
    "lon": -73.3792285,
    "units": "feet"
  },
  "assets": [
    {
      "id": "stephentown_terrain",
      "type": "terrain_heightmap",
      "version": "usgs-ned-1-3-arcsec",
      "path": "/world/terrain/stephentown_dem.bin",
      "metaPath": "/world/terrain/stephentown_dem.json"
    }
  ]
}
```

## Asset Hosting

- `/world/assets` maps to `data/world/assets`
- `/world/terrain` maps to `data/terrain`

## Caching

Clients should cache downloaded assets and only refresh when the manifest version or
asset version changes.
