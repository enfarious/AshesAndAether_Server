/**
 * Vault template definitions.
 *
 * For the initial implementation we hardcode a single test vault.
 * Later this can be replaced with DB-driven templates via a
 * VaultTemplate Prisma model.
 */

import type { RoomType, VaultGenParams, VaultGeometry } from './VaultTileGrid';

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
}

/**
 * Mob definitions per room type, used with `buildRoomsFromTier()` to
 * automatically generate the room list from a vault tier.
 */
export interface VaultTierMobDefs {
  /** Mobs spawned in the ENTRY room (lighter resistance). */
  entry: VaultMobSpawnDef[];
  /** Mobs spawned in each TRASH room. */
  trash: VaultMobSpawnDef[];
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

  return types.map((type) => {
    const namePool = ROOM_NAMES[type];
    const name = namePool[typeCounts[type] % namePool.length]!;
    typeCounts[type]++;

    const isBossRoom = type === 'SUB_BOSS' || type === 'BOSS';

    let mobs: VaultMobSpawnDef[];
    switch (type) {
      case 'ENTRY':    mobs = mobDefs.entry;   break;
      case 'TRASH':    mobs = mobDefs.trash;   break;
      case 'SUB_BOSS': mobs = mobDefs.subBoss; break;
      case 'BOSS':     mobs = mobDefs.boss;    break;
    }

    return {
      name,
      isBossRoom,
      mobs,
      spawnPositions: { player: DEFAULT_PLAYER_SPAWNS, mob: DEFAULT_MOB_SPAWNS },
    };
  });
}

// ─── Mob definitions for the Ruined Lab vault ────────────────────────────────

const LAB_MOB_DEFS: VaultTierMobDefs = {
  entry: [
    { mobTag: 'vault.construct.drone', count: 3, levelOffset: 0, isBoss: false },
  ],
  trash: [
    { mobTag: 'vault.construct.drone', count: 2, levelOffset: 0, isBoss: false },
    { mobTag: 'vault.construct.sentinel', count: 1, levelOffset: 1, isBoss: false },
  ],
  subBoss: [
    { mobTag: 'vault.construct.sentinel', count: 1, levelOffset: 1, isBoss: false },
    { mobTag: 'vault.construct.overseer', count: 1, levelOffset: 2, isBoss: true },
  ],
  boss: [
    { mobTag: 'vault.construct.drone', count: 2, levelOffset: 0, isBoss: false },
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
    roomSizeRange: [30, 50],
    bossRoomSizeRange: [40, 80],
    // Chain-based layout
    chain: true,
    tier: 1,
    corridorLength: 8,
  },
};
