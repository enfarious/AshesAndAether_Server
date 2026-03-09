/**
 * Vault template definitions.
 *
 * For the initial implementation we hardcode a single test vault.
 * Later this can be replaced with DB-driven templates via a
 * VaultTemplate Prisma model.
 */

import type { RoomDigOverrides, RoomType, VaultGenParams, VaultGeometry } from './VaultTileGrid';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VaultMobSpawnDef {
  /** Mob tag used to look up the template for spawning */
  mobTag: string;
  /** How many of this mob to spawn in the room */
  count: number;
  /** Added to the vault's baseLevel when spawning */
  levelOffset: number;
  /** Boss mobs are highlighted to the player and may have alternate phases */
  isBoss: boolean;
}

export interface VaultRoomDef {
  name: string;
  isBossRoom: boolean;
  mobs: VaultMobSpawnDef[];
  spawnPositions: {
    player: Array<{ x: number; y: number; z: number }>;
    mob: Array<{ x: number; y: number; z: number }>;
  };
  /** Per-room CA overrides (set by trash variants, overrides the type-level defaults). */
  digOverrides?: RoomDigOverrides;
  /** Per-room size range override (set by trash variants). */
  sizeRange?: [number, number];
}

/**
 * A trash room variant — pairs a mob composition with optional dig/size
 * overrides so the room shape matches the tactical intent.
 */
export interface VaultTrashVariant {
  /** Human-readable label (used for room name pool). */
  label: string;
  /** Mob composition for this variant. */
  mobs: VaultMobSpawnDef[];
  /** CA overrides — tight corridors for melee, open arenas for ranged, etc. */
  digOverrides?: RoomDigOverrides;
  /** Size range override — small ambush rooms vs. large killboxes. */
  sizeRange?: [number, number];
}

/**
 * Mob definitions per room type, used with `buildRoomsFromTier()` to
 * automatically generate the room list from a vault tier.
 */
export interface VaultTierMobDefs {
  /** Mobs spawned in the ENTRY room (lighter resistance). */
  entry: VaultMobSpawnDef[];
  /** Mobs spawned in each TRASH room (fallback when trashVariants is absent). */
  trash: VaultMobSpawnDef[];
  /**
   * When present, each TRASH room cycles through these variants instead of
   * using the flat `trash` list. Each variant can override dig params and
   * size range so the room geometry matches the mob composition.
   */
  trashVariants?: VaultTrashVariant[];
  /** Mobs spawned in the SUB_BOSS room. */
  subBoss: VaultMobSpawnDef[];
  /** Mobs spawned in the BOSS room. */
  boss: VaultMobSpawnDef[];
}

export interface VaultTemplateDefinition {
  templateId: string;
  name: string;
  description: string;
  /** ItemTag name that the entry key must carry */
  requiredKeyTag: string;
  /** ItemTag name for the fragment items */
  requiredFragmentTag: string;
  /** Number of fragments consumed to assemble one key */
  fragmentsRequired: number;
  /** Base level for mob spawns (before levelOffset) */
  baseLevel: number;
  rooms: VaultRoomDef[];
  zoneDimensions: { sizeX: number; sizeY: number; sizeZ: number };
  /** Gold awarded on vault completion (before scaling bonuses) */
  completionGold: number;
  /** Cellular-automata generation parameters. When present, tile grid is generated. */
  generation?: VaultGenParams;
  /** 3D geometry for vault walls and ceiling. */
  geometry?: VaultGeometry;
  /** Tier-based mob definitions. When present, rooms are generated via buildRoomsFromTier(). */
  tierMobDefs?: VaultTierMobDefs;
}

// ─── Room name pools ─────────────────────────────────────────────────────────

const ROOM_NAMES: Record<RoomType, string[]> = {
  ENTRY:    ['Entry Chamber', 'Antechamber', 'Breach Point'],
  TRASH:    ['Collapsed Tunnels', 'Ambush Hall', 'Shattered Vault', 'Nexus Junction', 'The Gauntlet', 'Scrap Yard', 'Rusted Corridor', 'Decay Ward'],
  SUB_BOSS: ["Overseer's Den", 'Guardian Chamber', 'Sentinel Core'],
  BOSS:     ['Core Chamber', 'Heart of Corruption', 'Final Nexus'],
};

// ─── Build rooms from tier ───────────────────────────────────────────────────

/** Default spawn positions (fallback when tile grid is unavailable). */
const DEFAULT_PLAYER_SPAWNS = [
  { x: 0, y: 0, z: -15 },
  { x: -3, y: 0, z: -15 },
  { x: 3, y: 0, z: -15 },
  { x: -6, y: 0, z: -15 },
  { x: 6, y: 0, z: -15 },
];

const DEFAULT_MOB_SPAWNS = [
  { x: -5, y: 0, z: 5 },
  { x: 0, y: 0, z: 8 },
  { x: 5, y: 0, z: 5 },
];

/**
 * Generate the VaultRoomDef[] array from a tier and mob definitions.
 *
 * Sequence: ENTRY + tier×TRASH + SUB_BOSS + tier×TRASH + BOSS
 * T1 = 5 rooms, T2 = 7, T3 = 9, etc.
 */
export function buildRoomsFromTier(tier: number, mobDefs: VaultTierMobDefs): VaultRoomDef[] {
  const types: RoomType[] = ['ENTRY'];
  for (let i = 0; i < tier; i++) types.push('TRASH');
  types.push('SUB_BOSS');
  for (let i = 0; i < tier; i++) types.push('TRASH');
  types.push('BOSS');

  // Track how many rooms of each type we've seen (for name cycling)
  const typeCounts: Record<RoomType, number> = { ENTRY: 0, TRASH: 0, SUB_BOSS: 0, BOSS: 0 };

  let trashVariantIdx = 0;

  return types.map((type) => {
    const namePool = ROOM_NAMES[type];
    const isBossRoom = type === 'SUB_BOSS' || type === 'BOSS';

    let mobs: VaultMobSpawnDef[];
    let digOverrides: RoomDigOverrides | undefined;
    let sizeRange: [number, number] | undefined;
    let name: string;

    if (type === 'TRASH' && mobDefs.trashVariants && mobDefs.trashVariants.length > 0) {
      // Cycle through trash variants deterministically
      const variant = mobDefs.trashVariants[trashVariantIdx % mobDefs.trashVariants.length]!;
      trashVariantIdx++;
      mobs = variant.mobs;
      digOverrides = variant.digOverrides;
      sizeRange = variant.sizeRange;
      name = variant.label;
    } else {
      name = namePool[typeCounts[type] % namePool.length]!;
      typeCounts[type]++;

      switch (type) {
        case 'ENTRY':    mobs = mobDefs.entry;   break;
        case 'TRASH':    mobs = mobDefs.trash;   break;
        case 'SUB_BOSS': mobs = mobDefs.subBoss; break;
        case 'BOSS':     mobs = mobDefs.boss;    break;
      }
    }

    return {
      name,
      isBossRoom,
      mobs,
      spawnPositions: { player: DEFAULT_PLAYER_SPAWNS, mob: DEFAULT_MOB_SPAWNS },
      digOverrides,
      sizeRange,
    };
  });
}

// ─── Mob definitions for the Ruined Lab vault ────────────────────────────────

const LAB_MOB_DEFS: VaultTierMobDefs = {
  entry: [
    { mobTag: 'vault.construct.drone', count: 3, levelOffset: 0, isBoss: false },
  ],

  // Fallback for trash rooms when trashVariants isn't used
  trash: [
    { mobTag: 'vault.construct.drone', count: 2, levelOffset: 0, isBoss: false },
    { mobTag: 'vault.construct.sentinel', count: 1, levelOffset: 1, isBoss: false },
  ],

  // ── Trash room variants — each pairs mob composition with room shape ──
  trashVariants: [
    {
      // Open killbox — ranged mobs that exploit long sight-lines
      label: 'Targeting Range',
      mobs: [
        { mobTag: 'vault.construct.turret',    count: 2, levelOffset: 0, isBoss: false },
        { mobTag: 'vault.construct.drone',     count: 1, levelOffset: 0, isBoss: false },
      ],
      digOverrides: { wallChance: 0.28, smoothIterations: 7, minFloorRatio: 0.50 },
      sizeRange: [30, 42],
    },
    {
      // Tight ambush — melee-heavy swarm in cramped corridors
      label: 'Collapsed Tunnels',
      mobs: [
        { mobTag: 'vault.construct.drone',     count: 4, levelOffset: 0, isBoss: false },
      ],
      digOverrides: { wallChance: 0.48, smoothIterations: 4, minFloorRatio: 0.25 },
      sizeRange: [22, 32],
    },
    {
      // Mixed patrol — balanced composition, standard room
      label: 'Nexus Junction',
      mobs: [
        { mobTag: 'vault.construct.drone',     count: 2, levelOffset: 0, isBoss: false },
        { mobTag: 'vault.construct.sentinel',  count: 1, levelOffset: 1, isBoss: false },
      ],
      // No overrides — uses the TRASH type defaults
    },
  ],

  subBoss: [
    { mobTag: 'vault.construct.sentinel', count: 2, levelOffset: 1, isBoss: false },
    { mobTag: 'vault.construct.overseer', count: 1, levelOffset: 2, isBoss: true },
  ],
  boss: [
    { mobTag: 'vault.construct.sentinel', count: 2, levelOffset: 1, isBoss: false },
    { mobTag: 'vault.construct.overlord', count: 1, levelOffset: 3, isBoss: true },
  ],
};

// ─── Test Vault ───────────────────────────────────────────────────────────────

export const TEST_VAULT_TEMPLATE: VaultTemplateDefinition = {
  templateId: 'vault_ruined_lab',
  name: 'Ruined Nanotech Lab',
  description: 'A collapsed pre-war laboratory overrun with corrupted constructs.',
  requiredKeyTag: 'vault_key_lab',
  requiredFragmentTag: 'vault_fragment_lab',
  fragmentsRequired: 3,
  baseLevel: 5,
  rooms: buildRoomsFromTier(1, LAB_MOB_DEFS),
  zoneDimensions: { sizeX: 900, sizeY: 20, sizeZ: 900 },
  completionGold: 100,
  tierMobDefs: LAB_MOB_DEFS,
  geometry: {
    wallHeight: 15,
    ceilingHeight: 15,
    ceilingType: 'flat',
  },
  generation: {
    wallChance: 0.40,
    smoothIterations: 5,
    minFloorRatio: 0.30,
    corridorWidth: 3,
    entryRoomSizeRange:   [20, 28],   // compact starting chamber
    roomSizeRange:        [25, 45],   // trash rooms — wide variety
    subBossRoomSizeRange: [32, 42],   // sub-boss — noticeably bigger
    bossRoomSizeRange:    [36, 48],   // boss — largest, but not absurd
    // Per-room-type cellular-automata overrides
    roomDigOverrides: {
      ENTRY:    { wallChance: 0.35, minFloorRatio: 0.40 }, // more open, welcoming
      TRASH:    { wallChance: 0.42 },                       // slightly more chaotic
      SUB_BOSS: { wallChance: 0.38, smoothIterations: 6 },  // smoother, arena-like
      BOSS:     { wallChance: 0.32, smoothIterations: 7, minFloorRatio: 0.45 }, // open arena
    },
    // Chain-based layout
    chain: true,
    tier: 1,
    corridorLength: 8,
  },
};
