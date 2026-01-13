# Unity Client Quick Setup

This guide is the minimum path for login → asset download → world entry.

## Endpoints

- Gateway HTTP: `http://localhost:3100`
- WebSocket: `ws://localhost:3100/socket.io/`
- Assets list: `GET /world/assets`
- Zone manifest: `GET /world/assets/:zoneId`
- Terrain files: `/world/terrain/*`
- Asset files: `/world/assets/*`

## Connection Flow

1) **Connect Socket.IO**
- Connect to `ws://localhost:3100/socket.io/`

2) **Handshake**
- Emit `handshake` with client details/capabilities.

3) **Authenticate**
- Emit `auth` (guest or credential).

4) **Select/Create Character**
- Emit `character_create` or `character_select`.

5) **Receive `world_entry`**
- Includes character + zone + initial entities.

## Asset Download Flow

1) **List zones**
- `GET /world/assets` → array of zone IDs.

2) **Fetch zone manifest**
- `GET /world/assets/USA_NY_Stephentown`
- Cache the response. Use `If-None-Match` with the returned `ETag`.

3) **Download assets**
- Use `path`/`metaPath` from the manifest.
- Cache files on disk; only re-download when the manifest changes.

## Coordinate Alignment

The manifest includes:
- `origin` (lat/lon) and `units`
- `projection` = `equirectangular`

Clients should use the same lat/lon → local feet conversion as the server.

## Suggested Cache Keys

- `manifest_etag:{zoneId}`
- `asset_version:{assetId}`

## Notes

- Terrain heightmaps are Float32 grids. See `docs/TERRAIN_PIPELINE.md`.
- Mesh assets are placeholders until we bake them.
