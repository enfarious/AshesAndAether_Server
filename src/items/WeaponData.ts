import type { DamageType } from '@/game/abilities/AbilityTypes';
import type { DamageProfileSegment, PhysicalDamageType } from '@/combat/types';

export type WeaponDamageProfile = {
  damageType: DamageType;
  physicalType?: PhysicalDamageType;
  ratio: number;
};

export type WeaponDefinition = {
  baseDamage?: number;
  speed?: number;
  damageProfiles?: WeaponDamageProfile[];
};

type ItemProperties = {
  weapon?: WeaponDefinition;
};

export function getWeaponDefinition(properties: unknown): WeaponDefinition | null {
  if (!properties || typeof properties !== 'object') return null;
  const weapon = (properties as ItemProperties).weapon;
  if (!weapon || typeof weapon !== 'object') return null;
  return weapon;
}

export function buildDamageProfiles(weapon: WeaponDefinition | null): DamageProfileSegment[] | null {
  const profiles = weapon?.damageProfiles;
  if (!profiles || !Array.isArray(profiles) || profiles.length === 0) return null;

  const cleaned = profiles
    .filter(profile => profile && typeof profile.ratio === 'number' && profile.ratio > 0)
    .map(profile => ({
      damageType: profile.damageType,
      physicalType: profile.physicalType,
      ratio: profile.ratio,
    }));

  return cleaned.length > 0 ? cleaned : null;
}

export function getPrimaryPhysicalType(profiles: DamageProfileSegment[] | null): PhysicalDamageType | undefined {
  if (!profiles) return undefined;
  let top: { ratio: number; physicalType?: PhysicalDamageType } | null = null;

  for (const profile of profiles) {
    if (profile.damageType !== 'physical' || !profile.physicalType) continue;
    if (!top || profile.ratio > top.ratio) {
      top = { ratio: profile.ratio, physicalType: profile.physicalType };
    }
  }

  return top?.physicalType;
}

export function getPrimaryDamageType(profiles: DamageProfileSegment[] | null): DamageType | undefined {
  if (!profiles || profiles.length === 0) return undefined;
  let top = profiles[0];

  for (const profile of profiles) {
    if (profile.ratio > top.ratio) {
      top = profile;
    }
  }

  return top.damageType;
}
