/**
 * FoundingCeremony — In-memory state machine for the guild founding narrative.
 *
 * Flow:
 * 1. Founder runs /guild create "Name" TAG → validates, stores pending ceremony
 * 2. Each co-founder runs /guild accept → records consent
 * 3. Once all 3 consent → runs narrative sequence → creates guild
 *
 * State is in-memory only. If the server restarts, pending ceremonies are lost
 * and players simply retry. This is intentional — no DB clutter for ceremonies.
 */

import { GuildService } from './GuildService';

// ── Types ──

export interface CeremonyState {
  founderId: string;
  founderName: string;
  coFounderIds: string[];
  coFounderNames: string[];
  guildName: string;
  guildTag: string;
  zoneId: string;
  consented: Set<string>; // Character IDs that have consented (founder auto-consents)
  createdAt: number;
  expiresAt: number; // Ceremonies expire after 5 minutes
}

export interface NarrativeStep {
  step: number;
  totalSteps: number;
  narrative: string;
  delayMs: number; // Delay before sending the next step
}

export type NarrativeCallback = (
  characterIds: string[],
  step: NarrativeStep,
) => void;

export type CeremonyCompleteCallback = (
  result: {
    success: boolean;
    guildId?: string;
    guildName: string;
    guildTag: string;
    founderIds: string[];
    error?: string;
  },
) => void;

// ── Narrative Text ──

function buildNarrativeSteps(
  founderName: string,
  coFounderNames: string[],
  guildName: string,
  guildTag: string,
): NarrativeStep[] {
  const allNames = [founderName, ...coFounderNames];
  const nameList = allNames.join(', ');

  return [
    {
      step: 1,
      totalSteps: 5,
      narrative: `The three of you gather close. ${nameList} — drawn together by shared purpose. The air hums with quiet intent.`,
      delayMs: 3000,
    },
    {
      step: 2,
      totalSteps: 5,
      narrative: `A charter is drawn. The name is spoken aloud: "${guildName}." The tag [${guildTag}] is inscribed at its head.`,
      delayMs: 3000,
    },
    {
      step: 3,
      totalSteps: 5,
      narrative: `${founderName} signs first, as founder. The ink catches the light — something old in it, something binding.`,
      delayMs: 3000,
    },
    {
      step: 4,
      totalSteps: 5,
      narrative: `${coFounderNames[0]} signs next, then ${coFounderNames[1]}. Three names on the charter. Three voices made one.`,
      delayMs: 3000,
    },
    {
      step: 5,
      totalSteps: 5,
      narrative: `The charter seals itself. The guild "${guildName}" [${guildTag}] is founded. What you build from here is yours to decide.`,
      delayMs: 0,
    },
  ];
}

// ── Public Announcement ──

function buildPublicAnnouncement(guildName: string, guildTag: string): string {
  return `A new guild has been founded: "${guildName}" [${guildTag}]. The charter is sealed.`;
}

// ── Ceremony Manager ──

const CEREMONY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class FoundingCeremonyManager {
  // Keyed by founder characterId
  private ceremonies: Map<string, CeremonyState> = new Map();

  // Also index by co-founder IDs for quick lookup on /guild accept
  private coFounderIndex: Map<string, string> = new Map(); // coFounderId -> founderId

  /**
   * Start a founding ceremony. The founder auto-consents.
   * Returns an error string if validation fails, null on success.
   */
  startCeremony(data: {
    founderId: string;
    founderName: string;
    coFounderIds: string[];
    coFounderNames: string[];
    guildName: string;
    guildTag: string;
    zoneId: string;
  }): string | null {
    const { founderId, coFounderIds } = data;

    // Check no existing ceremony for this founder
    if (this.ceremonies.has(founderId)) {
      return 'You already have a pending founding ceremony. Wait for it to expire or complete.';
    }

    // Check co-founders aren't in another pending ceremony
    for (const id of coFounderIds) {
      if (this.coFounderIndex.has(id)) {
        return 'One of the co-founders is already involved in a pending founding ceremony.';
      }
    }

    const now = Date.now();
    const state: CeremonyState = {
      ...data,
      consented: new Set([founderId]), // Founder auto-consents
      createdAt: now,
      expiresAt: now + CEREMONY_TIMEOUT_MS,
    };

    this.ceremonies.set(founderId, state);
    for (const id of coFounderIds) {
      this.coFounderIndex.set(id, founderId);
    }

    return null;
  }

  /**
   * Record consent from a co-founder. Returns the ceremony state if all have consented,
   * null if still waiting, or an error string.
   */
  recordConsent(characterId: string): CeremonyState | string | null {
    // Check if this character is a co-founder in a pending ceremony
    const founderId = this.coFounderIndex.get(characterId) ?? characterId;
    const state = this.ceremonies.get(founderId);

    if (!state) return 'No pending founding ceremony found.';

    // Check expiration
    if (Date.now() > state.expiresAt) {
      this.cleanupCeremony(founderId);
      return 'The founding ceremony has expired. Start again with /guild create.';
    }

    // Check character is part of this ceremony
    const allIds = [state.founderId, ...state.coFounderIds];
    if (!allIds.includes(characterId)) {
      return 'You are not part of this founding ceremony.';
    }

    // Already consented?
    if (state.consented.has(characterId)) {
      return 'You have already consented to this founding.';
    }

    state.consented.add(characterId);

    // Check if all have consented
    if (state.consented.size === allIds.length) {
      return state; // Ready to execute
    }

    return null; // Still waiting
  }

  /**
   * Execute the ceremony: run the narrative, then create the guild.
   * Cleans up state afterward.
   */
  async executeCeremony(
    founderId: string,
    narrativeCallback: NarrativeCallback,
    completeCallback: CeremonyCompleteCallback,
  ): Promise<void> {
    const state = this.ceremonies.get(founderId);
    if (!state) {
      completeCallback({
        success: false,
        guildName: '',
        guildTag: '',
        founderIds: [],
        error: 'Ceremony state not found.',
      });
      return;
    }

    const allIds = [state.founderId, ...state.coFounderIds];
    const steps = buildNarrativeSteps(
      state.founderName,
      state.coFounderNames,
      state.guildName,
      state.guildTag,
    );

    // Send narrative steps with delays
    for (const step of steps) {
      narrativeCallback(allIds, step);
      if (step.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      }
    }

    // Create the guild
    const result = await GuildService.createGuild({
      name: state.guildName,
      tag: state.guildTag,
      founderId: state.founderId,
      coFounderIds: state.coFounderIds,
    });

    // Cleanup
    this.cleanupCeremony(founderId);

    if (result.success && result.guild) {
      completeCallback({
        success: true,
        guildId: result.guild.id,
        guildName: state.guildName,
        guildTag: state.guildTag,
        founderIds: allIds,
      });
    } else {
      completeCallback({
        success: false,
        guildName: state.guildName,
        guildTag: state.guildTag,
        founderIds: allIds,
        error: result.error,
      });
    }
  }

  /**
   * Cancel a pending ceremony.
   */
  cancelCeremony(founderId: string): void {
    this.cleanupCeremony(founderId);
  }

  /**
   * Get ceremony state for a character (founder or co-founder).
   */
  getCeremonyFor(characterId: string): CeremonyState | null {
    // Direct lookup (founder)
    const direct = this.ceremonies.get(characterId);
    if (direct) return direct;

    // Indirect lookup (co-founder)
    const founderId = this.coFounderIndex.get(characterId);
    if (founderId) return this.ceremonies.get(founderId) ?? null;

    return null;
  }

  /**
   * Get the public announcement text for nearby players.
   */
  static getPublicAnnouncement(guildName: string, guildTag: string): string {
    return buildPublicAnnouncement(guildName, guildTag);
  }

  /**
   * Clean up expired ceremonies. Call periodically.
   */
  cleanupExpired(): void {
    const now = Date.now();
    for (const [founderId, state] of this.ceremonies.entries()) {
      if (now > state.expiresAt) {
        this.cleanupCeremony(founderId);
      }
    }
  }

  // ── Internal ──

  private cleanupCeremony(founderId: string): void {
    const state = this.ceremonies.get(founderId);
    if (!state) return;

    for (const id of state.coFounderIds) {
      this.coFounderIndex.delete(id);
    }
    this.ceremonies.delete(founderId);
  }
}
