import type { PhysicalDamageType } from '@/combat/types';

type ArmorDefinition = {
  qualityBias?: Record<string, number>;
};

type ItemProperties = {
  armor?: ArmorDefinition;
};

export type QualityBiasMultipliers = Record<PhysicalDamageType, number>;

export function buildQualityBiasMultipliers(propertiesList: Array<unknown>): QualityBiasMultipliers {
  const multipliers: QualityBiasMultipliers = {
    blunt: 1,
    slash: 1,
    pierce: 1,
  };

  for (const properties of propertiesList) {
    if (!properties || typeof properties !== 'object') continue;
    const armor = (properties as ItemProperties).armor;
    if (!armor || typeof armor !== 'object') continue;
    const bias = armor.qualityBias;
    if (!bias || typeof bias !== 'object') continue;

    for (const [key, raw] of Object.entries(bias)) {
      const normalized = normalizePhysicalType(key);
      if (!normalized) continue;
      const value = normalizeBias(raw);
      multipliers[normalized] *= 1 - value;
    }
  }

  return multipliers;
}

function normalizePhysicalType(value: string): PhysicalDamageType | null {
  const lower = value.toLowerCase();
  if (lower === 'blunt') return 'blunt';
  if (lower === 'slash') return 'slash';
  if (lower === 'pierce') return 'pierce';
  return null;
}

function normalizeBias(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  let bias = value;
  if (Math.abs(bias) > 1) {
    bias = bias / 100;
  }
  const maxBias = 0.9;
  return Math.max(-maxBias, Math.min(maxBias, bias));
}
