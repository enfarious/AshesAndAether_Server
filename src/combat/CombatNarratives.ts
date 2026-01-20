import type { DamageType } from '@/game/abilities/AbilityTypes';
import type { CombatAbilityDefinition, DamageResult, PhysicalDamageType } from './types';

const HIT_VERBS: Record<PhysicalDamageType, string[]> = {
  blunt: ['strikes', 'slams', 'thumps'],
  slash: ['slashes', 'cuts', 'cleaves'],
  pierce: ['stabs', 'pierces', 'skewers'],
};

const NEAR_MISS_VERBS: Record<PhysicalDamageType, string[]> = {
  blunt: ['deflects off', 'is absorbed by', 'skitters off'],
  slash: ['glances off', 'scratches', 'nicks'],
  pierce: ['grazes', 'bounces off', 'pricks'],
};

const CRIT_VERBS: Record<PhysicalDamageType, string[]> = {
  blunt: ['smashes', 'crushes', 'demolishes'],
  slash: ['lacerates', 'severs', 'gashes'],
  pierce: ['punctures', 'perforates', 'impales'],
};

const PENETRATE_VERBS: Record<PhysicalDamageType, string[]> = {
  blunt: ['drives through', 'punches through', 'shatters through'],
  slash: ['carves through', 'rips through', 'slices through'],
  pierce: ['punches through', 'drills through', 'pierces through'],
};

const MAGIC_HIT_VERBS: Record<Exclude<DamageType, 'physical'>, string[]> = {
  magic: ['blasts', 'strikes', 'slams'],
  fire: ['scorches', 'burns', 'sears'],
  ice: ['freezes', 'chills', 'rimes'],
  lightning: ['shocks', 'jolts', 'crackles into'],
  poison: ['poisons', 'corrodes', 'sickens'],
  holy: ['sears', 'purges', 'brands'],
  dark: ['blights', 'corrupts', 'withers'],
};

const GENERIC_NEAR_MISS = ['grazes', 'glances off', 'clips'];
const GENERIC_CRIT = ['devastates', 'crushes', 'shatters'];
const GENERIC_PENETRATE = ['pierces through', 'drives through', 'tears through'];
const GENERIC_HIT = ['hits', 'strikes', 'smashes'];

const ATTACK_NOUN: Record<PhysicalDamageType, string> = {
  blunt: 'blow',
  slash: 'slash',
  pierce: 'thrust',
};

const QUALITY_ADVERBS: Record<DamageResult['quality'], string> = {
  poor: 'weakly',
  normal: '',
  good: 'solidly',
};

export function buildCombatNarrative(
  kind: 'miss' | 'hit',
  context: {
    attackerName: string;
    targetName: string;
    ability: CombatAbilityDefinition;
    result?: DamageResult;
  }
): string {
  const { attackerName, targetName, ability, result } = context;
  const damageType = ability.damage?.type ?? 'physical';
  const physicalType = damageType === 'physical' ? ability.damage?.physicalType : undefined;

  if (kind === 'miss') {
    return `${attackerName} misses ${targetName}.`;
  }

  const amount = result?.amount ?? 0;

  if (result?.critical) {
    const verb = pickVerb(CRIT_VERBS, GENERIC_CRIT, damageType, physicalType, { useMagic: true });
    return `${attackerName} critically strikes ${targetName}, ${verb} them for ${amount} damage!`;
  }

  if (result?.deflected || result?.glancing) {
    const noun = physicalType ? ATTACK_NOUN[physicalType] : 'attack';
    const verb = pickVerb(NEAR_MISS_VERBS, GENERIC_NEAR_MISS, damageType, physicalType, { useMagic: false });
    return `${attackerName} nearly misses ${targetName}; the ${noun} ${verb} ${targetName} for ${amount} damage.`;
  }

  if (result?.penetrating) {
    const verb = pickVerb(PENETRATE_VERBS, GENERIC_PENETRATE, damageType, physicalType, { useMagic: true });
    return `${attackerName} ${verb} ${targetName} for ${amount} damage.`;
  }

  const verb = pickVerb(HIT_VERBS, GENERIC_HIT, damageType, physicalType, { useMagic: true });
  const adverb = (result && !result.critical && !result.glancing && !result.deflected)
    ? QUALITY_ADVERBS[result.quality]
    : '';
  const adverbText = adverb ? `${adverb} ` : '';
  return `${attackerName} ${adverbText}${verb} ${targetName} for ${amount} damage.`;
}

function pickVerb(
  physicalMap: Record<PhysicalDamageType, string[]>,
  fallback: string[],
  damageType: DamageType,
  physicalType?: PhysicalDamageType,
  options?: { useMagic?: boolean }
): string {
  if (damageType !== 'physical') {
    if (!options?.useMagic) {
      return pick(fallback);
    }
    const list = MAGIC_HIT_VERBS[damageType] || fallback;
    return pick(list);
  }

  if (physicalType && physicalMap[physicalType]) {
    return pick(physicalMap[physicalType]);
  }

  return pick(fallback);
}

function pick(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)];
}
