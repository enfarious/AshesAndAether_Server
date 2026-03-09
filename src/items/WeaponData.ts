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
  /** Explicit reach in metres.  Overrides the tag-based default when set. */
  range?: number;
  damageProfiles?: WeaponDamageProfile[];
};

/**
 * Unarmed reach contribution — bare knuckles add no extra reach beyond the
 * body-radius + arm baseline that validateRange always includes.
 * Effective unarmed range = BASE_REACH(1) + 2×ENTITY_RADIUS(0.5) + 0 = 2.0 m.
 */
export const UNARMED_RANGE = 0;

/**
 * Weapon reach in metres, keyed by ItemTag name.
 * This is the weapon's own contribution; validateRange adds BASE_REACH + both
 * entity radii on top, so effective range = 2 m + weaponReach.
 *
 * Melee — weapon reach → effective centre-to-centre range
 *   unarmed                      0     →  2.0 m  ( 6.6 ft)
 *   claw                         0.3   →  2.3 m  ( 7.5 ft)
 *   knife                        0.3   →  2.3 m  ( 7.5 ft)
 *   dagger                       0.4   →  2.4 m  ( 7.9 ft)
 *   handaxe / club               0.5   →  2.5 m  ( 8.2 ft)
 *   shortsword / mace            0.65  →  2.65 m ( 8.7 ft)
 *   axe                          0.65  →  2.65 m ( 8.7 ft)
 *   sword                        1.0   →  3.0 m  ( 9.8 ft)
 *   warhammer                    0.9   →  2.9 m  ( 9.5 ft)
 *   longsword                    1.25  →  3.25 m (10.7 ft)
 *   staff                        1.5   →  3.5 m  (11.5 ft)
 *   greataxe / maul              1.5   →  3.5 m  (11.5 ft)
 *   greatsword                   1.75  →  3.75 m (12.3 ft)
 *   polearm / halberd            2.25  →  4.25 m (13.9 ft)
 *   spear                        2.25  →  4.25 m (13.9 ft)
 *   lance                        3.0   →  5.0 m  (16.4 ft)
 *
 * Ranged — weapon reach only (no radius/arm baseline matters at these distances)
 *   sling     15 m   shortbow/thrown  20 m   bow/longbow  30 m
 *   crossbow  35 m   pistol/gun       40 m   rifle/musket 60 m
 */
export const WEAPON_TAG_RANGES: Record<string, number> = {
  // ── H2H / natural weapons ─────────────────────────────────────────────────
  claw:       0.3,
  // ── small blades (max 0.5 m) ─────────────────────────────────────────────
  knife:      0.3,
  dagger:     0.4,
  // ── short one-handers (max 0.75 m) ───────────────────────────────────────
  handaxe:    0.5,
  club:       0.5,
  shortsword: 0.65,
  mace:       0.65,
  axe:        0.65,
  // ── standard / long one-handers (max 1.5 m) ──────────────────────────────
  sword:      1.0,
  warhammer:  0.9,
  longsword:  1.25,
  // ── two-handers (max 2 m) ─────────────────────────────────────────────────
  staff:      1.5,
  greataxe:   1.5,
  maul:       1.5,
  greatsword: 1.75,
  // ── polearms (max 3 m) ───────────────────────────────────────────────────
  halberd:    2.25,
  polearm:    2.25,
  spear:      2.25,
  lance:      3.0,
  // ── ranged ───────────────────────────────────────────────────────────────
  sling:      15,
  thrown:     20,
  shortbow:   20,
  bow:        30,
  longbow:    30,
  crossbow:   35,
  pistol:     40,
  gun:        40,
  rifle:      60,
  musket:     60,
};

/**
 * Resolve the effective reach for a weapon.
 *
 * Priority:
 *   1. Explicit `range` on the WeaponDefinition JSON (set by content creators per item)
 *   2. Best-match from the weapon's tags via WEAPON_TAG_RANGES
 *   3. UNARMED_RANGE fallback
 */
export function getWeaponRange(
  weapon: WeaponDefinition | null,
  tags: string[],
): number {
  if (weapon?.range != null) return weapon.range;

  // Pick the largest range from the tags so a "spear" + "pierce" returns spear range
  let best = 0;
  for (const tag of tags) {
    const r = WEAPON_TAG_RANGES[tag.toLowerCase()];
    if (r != null && r > best) best = r;
  }
  return best > 0 ? best : UNARMED_RANGE;
}

/**
 * Map a weapon's effective reach to one of three combat range bands.
 * Matches the PreferredRange tiers in CompanionCombatSettings:
 *   close — melee striking distance  (effective reach ≤ 5 m)
 *   mid   — polearm / short-ranged   (effective reach ≤ 10 m)
 *   long  — ranged / caster          (effective reach > 10 m)
 *
 * "effectiveReach" is the raw weapon reach, NOT the full combat effective
 * range (which adds BASE_REACH + radii). The thresholds here account for
 * that: a spear at 2.25 m reach → ~4.25 m effective → close/mid border.
 */
export function getWeaponRangeBand(weaponReach: number): 'close' | 'mid' | 'long' {
  // Polearms (halberd 2.25, spear 2.25, lance 3.0) should be "mid"
  // Ranged weapons (sling 15+) should be "long"
  if (weaponReach >= 10) return 'long';
  if (weaponReach >= 2.0) return 'mid';
  return 'close';
}

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
