import { ElevationService } from './src/world/terrain/ElevationService.ts';

const svc = ElevationService.tryLoad();
if (svc) {
  const meta = svc.getMetadata();
  console.log('Center:', meta.center);
  const centerLat = meta.center.lat;
  const centerLon = meta.center.lon;
  console.log('Elevation at center (0,0):', svc.getElevationMeters(centerLat, centerLon), 'meters');
  
  // Test a point slightly offset
  console.log('Elevation at origin:', svc.getElevationMeters(meta.originLat, meta.originLon), 'meters');
} else {
  console.log('Could not load elevation data');
}
