/**
 * Vault template definitions.
 *
 * For the initial implementation we hardcode a single test vault.
 * Later this can be replaced with DB-driven templates via a
 * VaultTemplate Prisma model.
 */

import type { VaultGenParams } from './VaultTileGrid';

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
}

// ─── Test Vault ───────────────────────────────────────────────────────────────

export const TEST_VAULT_TEMPLATE: VaultTemplateDefinition = {
  templateId: 'vault_ruined_lab',
  name: 'Ruined Nanotech Lab',
  description: 'A collapsed pre-war laboratory overrun with corrupted constructs.',
  requiredKeyTag: 'vault_key_lab',
  requiredFragmentTag: 'vault_fragment_lab',
  fragmentsRequired: 3,
  baseLevel: 5,
  rooms: [
    // ── Room 1: Entry Chamber ───────────────────────────────────────
    {
      name: 'Entry Chamber',
      isBossRoom: false,
      mobs: [
        { mobTag: 'vault.construct.drone', count: 3, levelOffset: 0, isBoss: false },
      ],
      spawnPositions: {
        player: [
          { x: 0, y: 0, z: -15 },
          { x: -3, y: 0, z: -15 },
          { x: 3, y: 0, z: -15 },
          { x: -6, y: 0, z: -15 },
          { x: 6, y: 0, z: -15 },
        ],
        mob: [
          { x: -5, y: 0, z: 5 },
          { x: 0, y: 0, z: 8 },
          { x: 5, y: 0, z: 5 },
        ],
      },
    },
    // ── Room 2: Collapsed Corridor ──────────────────────────────────
    {
      name: 'Collapsed Corridor',
      isBossRoom: false,
      mobs: [
        { mobTag: 'vault.construct.drone', count: 2, levelOffset: 0, isBoss: false },
        { mobTag: 'vault.construct.sentinel', count: 1, levelOffset: 1, isBoss: false },
      ],
      spawnPositions: {
        player: [
          { x: 0, y: 0, z: -15 },
          { x: -3, y: 0, z: -15 },
          { x: 3, y: 0, z: -15 },
          { x: -6, y: 0, z: -15 },
          { x: 6, y: 0, z: -15 },
        ],
        mob: [
          { x: -4, y: 0, z: 5 },
          { x: 4, y: 0, z: 5 },
          { x: 0, y: 0, z: 10 },
        ],
      },
    },
    // ── Room 3: Core Chamber (Boss) ─────────────────────────────────
    {
      name: 'Core Chamber',
      isBossRoom: true,
      mobs: [
        { mobTag: 'vault.construct.drone', count: 2, levelOffset: 0, isBoss: false },
        { mobTag: 'vault.construct.overlord', count: 1, levelOffset: 3, isBoss: true },
      ],
      spawnPositions: {
        player: [
          { x: 0, y: 0, z: -20 },
          { x: -3, y: 0, z: -20 },
          { x: 3, y: 0, z: -20 },
          { x: -6, y: 0, z: -20 },
          { x: 6, y: 0, z: -20 },
        ],
        mob: [
          { x: -8, y: 0, z: 5 },
          { x: 8, y: 0, z: 5 },
          { x: 0, y: 0, z: 12 },
        ],
      },
    },
  ],
  zoneDimensions: { sizeX: 60, sizeY: 20, sizeZ: 60 },
  completionGold: 100,
  generation: { wallChance: 0.45, smoothIterations: 5, minFloorRatio: 0.35 },
};
