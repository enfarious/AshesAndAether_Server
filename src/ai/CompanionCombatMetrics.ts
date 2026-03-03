import { logger } from '@/utils/logger';

/**
 * Per-companion per-fight contribution metrics.
 *
 * Logged at fight end for vault scaling analysis. Three possible outcomes
 * (from design doc): companions underperform, match player level, or crush
 * content. Empirical data from these metrics determines which bucket they
 * fall into.
 */

export interface FightMetrics {
  companionId: string;
  companionName: string;
  archetype: string;
  fightStartedAt: number;
  fightEndedAt: number;
  durationMs: number;

  // Combat contribution
  damageDealt: number;
  damageAbsorbed: number;
  healsApplied: number;
  deaths: number;
  rescuesNeeded: number;  // Times a player had to save the companion

  // AI metrics
  llmCallCount: number;
  settingsChanges: number;
  abilitiesUsed: number;

  // Targets
  enemiesEngaged: number;
  killsContributed: number;
}

export class CompanionCombatMetrics {
  private companionId: string;
  private companionName: string;
  private archetype: string;

  // Current fight tracking (null when not in a fight)
  private fightStart: number | null = null;
  private damageDealt = 0;
  private damageAbsorbed = 0;
  private healsApplied = 0;
  private deaths = 0;
  private rescuesNeeded = 0;
  private llmCallCount = 0;
  private settingsChanges = 0;
  private abilitiesUsed = 0;
  private enemyIds = new Set<string>();
  private killsContributed = 0;

  constructor(companionId: string, companionName: string, archetype: string) {
    this.companionId = companionId;
    this.companionName = companionName;
    this.archetype = archetype;
  }

  startFight(): void {
    this.fightStart = Date.now();
    this.damageDealt = 0;
    this.damageAbsorbed = 0;
    this.healsApplied = 0;
    this.deaths = 0;
    this.rescuesNeeded = 0;
    this.llmCallCount = 0;
    this.settingsChanges = 0;
    this.abilitiesUsed = 0;
    this.enemyIds.clear();
    this.killsContributed = 0;
  }

  endFight(): FightMetrics | null {
    if (this.fightStart === null) return null;

    const now = Date.now();
    const metrics: FightMetrics = {
      companionId: this.companionId,
      companionName: this.companionName,
      archetype: this.archetype,
      fightStartedAt: this.fightStart,
      fightEndedAt: now,
      durationMs: now - this.fightStart,
      damageDealt: this.damageDealt,
      damageAbsorbed: this.damageAbsorbed,
      healsApplied: this.healsApplied,
      deaths: this.deaths,
      rescuesNeeded: this.rescuesNeeded,
      llmCallCount: this.llmCallCount,
      settingsChanges: this.settingsChanges,
      abilitiesUsed: this.abilitiesUsed,
      enemiesEngaged: this.enemyIds.size,
      killsContributed: this.killsContributed,
    };

    logger.info({
      companionId: this.companionId,
      companionName: this.companionName,
      archetype: this.archetype,
      durationMs: metrics.durationMs,
      damageDealt: metrics.damageDealt,
      damageAbsorbed: metrics.damageAbsorbed,
      healsApplied: metrics.healsApplied,
      deaths: metrics.deaths,
      llmCalls: metrics.llmCallCount,
      enemiesEngaged: metrics.enemiesEngaged,
      killsContributed: metrics.killsContributed,
    }, '[CompanionMetrics] Fight summary');

    this.fightStart = null;
    return metrics;
  }

  get isInFight(): boolean {
    return this.fightStart !== null;
  }

  recordDamageDealt(amount: number, targetId: string): void {
    this.damageDealt += amount;
    this.enemyIds.add(targetId);
  }

  recordDamageAbsorbed(amount: number): void {
    this.damageAbsorbed += amount;
  }

  recordHeal(amount: number): void {
    this.healsApplied += amount;
  }

  recordDeath(): void {
    this.deaths++;
  }

  recordRescueNeeded(): void {
    this.rescuesNeeded++;
  }

  recordLlmCall(): void {
    this.llmCallCount++;
  }

  recordSettingsChange(): void {
    this.settingsChanges++;
  }

  recordAbilityUsed(): void {
    this.abilitiesUsed++;
  }

  recordKillContribution(): void {
    this.killsContributed++;
  }
}
