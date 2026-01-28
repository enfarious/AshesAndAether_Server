/**
 * Tile pipelines module exports
 *
 * Provides data fetching and processing pipelines for truth layers.
 */

// Blob storage
export { BlobStorage, computeHash, getDefaultBlobStorage, type BlobStorageConfig } from './BlobStorage';

// Pipeline infrastructure
export {
  type TilePipeline,
  type PipelineResult,
  BaseTilePipeline,
  PipelineRegistry,
  getPipelineRegistry,
} from './TilePipeline';

// Elevation pipeline
export {
  ElevationPipeline,
  type TileElevationData,
  type ElevationPipelineConfig,
} from './ElevationPipeline';

// Population pipeline
export {
  PopulationPipeline,
  SettlementType,
  type TilePopulationData,
  type PopulationPipelineConfig,
} from './PopulationPipeline';

// Biome pipeline
export {
  BiomePipeline,
  BiomeType,
  ESALandCover,
  ESA_TO_BIOME,
  type TileBiomeData,
  type BiomePipelineConfig,
} from './BiomePipeline';

// Ruin generation pipeline
export {
  RuinGenPipeline,
  StructureType,
  StructureCondition,
  type PlacedStructure,
  type RoadSegment,
  type TileRuinLayout,
  type RuinGenPipelineConfig,
} from './RuinGenPipeline';

// Spawn table pipeline
export {
  SpawnTablePipeline,
  SpawnEntryType,
  type SpawnEntry,
  type SpawnGroup,
  type TileSpawnTable,
  type SpawnTablePipelineConfig,
} from './SpawnTablePipeline';

// POI pipeline
export {
  POIPipeline,
  POIType,
  POITier,
  type PointOfInterest,
  type TilePOILayout,
  type POIPipelineConfig,
} from './POIPipeline';

// Navmesh pipeline
export {
  NavmeshPipeline,
  WalkabilityFlag,
  MovementCost,
  type NavCell,
  type TileEdge,
  type TileNavmesh,
  type NavmeshPipelineConfig,
} from './NavmeshPipeline';

// Build runner
export {
  TileBuildRunner,
  type TileBuildRunnerConfig,
  type TileBuildRunnerEvents,
} from './TileBuildRunner';
