import { logger } from '@/utils/logger';
import { AbilityService } from '@/database';
import { CombatAbilityDefinition } from './types';
import { T1_ABILITIES } from './AbilityData';
import { ACTIVE_WEB } from '@/game/abilities/tree/ActiveWeb';

const BASIC_ATTACK: CombatAbilityDefinition = {
  id: 'basic_attack',
  name: 'Basic Attack',
  description: 'A simple weapon strike.',
  targetType: 'enemy',
  range: 2, // meters
  cooldown: 0,
  atbCost: 0,
  staminaCost: 5,
  damage: {
    type: 'physical',
    amount: 8,
    scalingStat: 'strength',
    scalingMultiplier: 0.4,
    physicalType: 'blunt',
  },
};

/**
 * Build a map from ability-tree node IDs (e.g. `active_tank_t1`) to the
 * corresponding combat-ability slug (e.g. `provoke`).  The client sends
 * node IDs from the action bar; the server stores abilities by slug.
 *
 * Matching is done by name (case-insensitive): the ActiveWeb node's `name`
 * field matches the CombatAbilityDefinition's `name` field.
 */
function buildNodeIdToSlugMap(): Map<string, string> {
  const nameToSlug = new Map<string, string>(
    T1_ABILITIES.map(a => [a.name.toLowerCase(), a.id]),
  );
  const nodeMap = new Map<string, string>();
  for (const node of ACTIVE_WEB) {
    const slug = nameToSlug.get(node.name.toLowerCase());
    if (slug) nodeMap.set(node.id, slug);
  }
  return nodeMap;
}

export class AbilitySystem {
  private inMemory: Map<string, CombatAbilityDefinition> = new Map([
    [BASIC_ATTACK.id, BASIC_ATTACK],
    ...T1_ABILITIES.map(a => [a.id, a] as [string, CombatAbilityDefinition]),
  ]);

  /** Maps ability-tree node IDs → combat ability slugs. */
  private nodeIdToSlug = buildNodeIdToSlugMap();

  async getAbility(abilityId: string): Promise<CombatAbilityDefinition | null> {
    try {
      const record = await AbilityService.findById(abilityId);
      if (record?.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
        const data = record.data as unknown as CombatAbilityDefinition;
        return {
          ...data,
          id: record.id,
          name: record.name,
          description: record.description || data.description,
        };
      }
    } catch (error) {
      logger.warn({ error, abilityId }, 'Ability lookup failed, using in-memory definitions');
    }

    // Direct slug lookup (e.g. 'provoke')
    const fallback = this.inMemory.get(abilityId);
    if (fallback) return fallback;

    // Resolve ability-tree node ID → combat ability slug
    // (client action bar sends node IDs like 'active_tank_t1')
    const resolvedSlug = this.nodeIdToSlug.get(abilityId);
    if (resolvedSlug) {
      const resolved = this.inMemory.get(resolvedSlug);
      if (resolved) {
        logger.debug({ nodeId: abilityId, abilitySlug: resolvedSlug }, 'Resolved node ID to ability');
        return resolved;
      }
    }

    return null;
  }

  async getAbilityByName(name: string): Promise<CombatAbilityDefinition | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;

    try {
      const record = await AbilityService.findByName(trimmed);
      if (record?.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
        const data = record.data as unknown as CombatAbilityDefinition;
        return {
          ...data,
          id: record.id,
          name: record.name,
          description: record.description || data.description,
        };
      }
    } catch (error) {
      logger.warn({ error, name: trimmed }, 'Ability lookup by name failed, using in-memory definitions');
    }

    const lower = trimmed.toLowerCase();
    for (const ability of this.inMemory.values()) {
      if (ability.name.toLowerCase() === lower || ability.id.toLowerCase() === lower) {
        return ability;
      }
    }

    return null;
  }

  getDefaultAbility(): CombatAbilityDefinition {
    return BASIC_ATTACK;
  }
}
