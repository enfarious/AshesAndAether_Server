import { logger } from '@/utils/logger';
import { AbilityService } from '@/database';
import { CombatAbilityDefinition } from './types';

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

export class AbilitySystem {
  private inMemory: Map<string, CombatAbilityDefinition> = new Map([
    [BASIC_ATTACK.id, BASIC_ATTACK],
  ]);

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

    const fallback = this.inMemory.get(abilityId) || null;
    return fallback;
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
