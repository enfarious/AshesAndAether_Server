/**
 * Generate navmesh for tiles around starting area (Stephentown)
 * 
 * This script:
 * 1. Queues NAV_BAKE jobs for tiles around Stephentown
 * 2. Starts TileBuildRunner to process them
 */
import { prisma } from '../src/database/DatabaseService';
import { TileService, TileBuildJobType } from '../src/world/tiles/TileService';
import { latLonToTile, getTilesInRadius } from '../src/world/tiles/TileUtils';
import { TileBuildRunner } from '../src/world/tiles/pipelines/TileBuildRunner';

async function main() {
  try {
    // Stephentown coordinates
    const stephentown = { lat: 42.5513326, lon: -73.3792285 };
    
    // Get tile at zoom 9 (macro tile)
    const macroTile = latLonToTile(stephentown.lat, stephentown.lon, 9);
    if (!macroTile) {
      console.error('Failed to get macro tile for Stephentown');
      process.exit(1);
    }
    
    console.log(`\n📍 Stephentown tile (macro): z=${macroTile.z} x=${macroTile.x} y=${macroTile.y}`);
    
    // Get surrounding tiles (radius 1)
    const tilesInArea = getTilesInRadius(macroTile, 1);
    console.log(`\n🗺️  Building navmesh for ${tilesInArea.length} tiles...`);
    
    let queuedCount = 0;
    for (const tile of tilesInArea) {
      // Ensure tile exists
      const tileRecord = await TileService.getOrCreateTile(tile);
      
      // Queue navmesh job
      await TileService.createBuildJob(
        tileRecord.id,
        TileBuildJobType.NAV_BAKE,
        1 // priority
      );
      
      queuedCount++;
      console.log(`  ✓ Queued NAV_BAKE for z=${tile.z} x=${tile.x} y=${tile.y}`);
    }
    
    console.log(`\n✅ Queued ${queuedCount} navmesh jobs`);
    
    // Start TileBuildRunner to process jobs
    console.log('\n⚙️  Starting TileBuildRunner...');
    const runner = new TileBuildRunner({
      pollInterval: 1000, // 1 second
      maxConcurrency: 2,
      registerDefaultPipelines: true,
    });
    
    runner.on('jobStarted', (jobId: string) => {
      console.log(`  ⏳ Processing ${jobId}...`);
    });
    
    runner.on('jobCompleted', (jobId: string) => {
      console.log(`  ✓ Job ${jobId} completed`);
    });
    
    runner.on('jobFailed', (jobId: string, _jobType, _tileId, error: string) => {
      console.error(`  ✗ Job ${jobId} failed: ${error}`);
    });
    
    await runner.start();
    
    // Run for 60 seconds or until all jobs complete
    console.log('\n⏱️  Processing navmesh jobs (timeout: 120s)...\n');
    await new Promise(resolve => setTimeout(resolve, 120000));
    
    await runner.stop();
    console.log('\n✅ Navmesh generation complete!\n');
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
