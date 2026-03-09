import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { logger } from '@/utils/logger';
import type { Companion } from '@prisma/client';
import type { ProximityRosterMessage } from '@/network/protocol/types';
import type { CompanionCombatSettings } from './CompanionCombatSettings';
import type { BehaviorNode } from './behaviors/BehaviorTreeExecutor';
import { ALLOWED_ACTIONS, ALLOWED_CONDITIONS } from './behaviors/HarvestBehavior';

interface NPCResponse {
  action: 'chat' | 'emote' | 'none';
  channel?: 'say' | 'shout' | 'emote';
  message?: string;
}

export interface EngagementContext {
  companionName: string;
  archetype: string;
  personalityType: string;
  mobName: string;
  mobFamily: string | null;
  mobSpecies: string | null;
  mobLevel: number;
  companionLevel: number;
  ownerNearby: boolean;
}

export interface CombatSettingsContext {
  companionName: string;
  archetype: string;
  personalityType: string;
  companionHealthRatio: number;
  currentSettings: CompanionCombatSettings;
  /** Enemy descriptions: e.g. ["rat (level 3)", "wolf alpha (level 7)"] */
  enemies: string[];
  /** Ally health states: e.g. ["Kael: 45%", "Lyra: 80%"] */
  allyStates: string[];
  /** Time in combat (seconds). */
  fightDurationSec: number;
  /** Why this update was triggered. */
  triggerReason: string;
  /** Player command if that was the trigger. */
  playerCommand?: string;
  /** Weapon range band the companion is using: 'close' | 'mid' | 'long'. */
  weaponRangeBand?: 'close' | 'mid' | 'long';
  /** Weapon name the companion is using, e.g. "Iron Shortsword". */
  weaponName?: string;
}

type LLMProvider = 'anthropic' | 'openai-compatible';

/**
 * Strip extended-thinking blocks that some models emit (Qwen, DeepSeek, etc.).
 * Handles `<think>…</think>`, `<thinking>…</thinking>`, and unclosed tags
 * from truncated responses. Always returns usable text or the original input.
 */
function stripThinkingTags(raw: string): string {
  // 1. Remove complete <think>…</think> / <thinking>…</thinking> blocks
  let cleaned = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');

  // 2. Unclosed tag (truncated response) — drop from opening tag to end of string
  cleaned = cleaned.replace(/<think(?:ing)?>[\s\S]*$/gi, '');

  cleaned = cleaned.trim();
  return cleaned || raw.trim();
}

/**
 * LLM service for generating NPC responses
 * Supports: Anthropic Claude, any OpenAI-compatible API (OpenAI, LMStudio, Ollama, etc.)
 */
export class LLMService {
  private provider: LLMProvider;
  private anthropic: Anthropic | null = null;
  private openaiClient: OpenAI | null = null;

  constructor() {
    this.provider = this.detectProvider();
    this.initializeProvider();
  }

  /**
   * Detect which provider to use based on environment
   */
  private detectProvider(): LLMProvider {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey && anthropicKey !== 'your-anthropic-api-key') {
      return 'anthropic';
    }

    // If any OpenAI-compatible config exists, use that
    const openaiKey = process.env.OPENAI_API_KEY;
    const baseUrl = process.env.OPENAI_BASE_URL;
    if ((openaiKey && openaiKey !== 'your-openai-api-key') || baseUrl) {
      return 'openai-compatible';
    }

    // Default to openai-compatible (works for local LLMs with no auth)
    return 'openai-compatible';
  }

  private initializeProvider(): void {
    switch (this.provider) {
      case 'anthropic':
        const anthropicKey = process.env.ANTHROPIC_API_KEY!;
        this.anthropic = new Anthropic({ apiKey: anthropicKey });
        logger.info('LLM Service initialized with Anthropic Claude');
        break;

      case 'openai-compatible':
        // Support any OpenAI-compatible API
        const apiKey = process.env.OPENAI_API_KEY || 'not-needed';
        const baseURL = process.env.OPENAI_BASE_URL || 'http://127.0.0.1:1234/v1';

        this.openaiClient = new OpenAI({
          apiKey,
          baseURL,
        });

        const providerName = baseURL.includes('openai.com')
          ? 'OpenAI'
          : baseURL.includes('localhost') || baseURL.includes('127.0.0.1')
          ? 'Local LLM (LMStudio/Ollama)'
          : 'Custom OpenAI-compatible API';

        logger.info({ baseURL }, `LLM Service initialized with ${providerName}`);
        break;
    }
  }

  /**
   * Generate NPC response based on context
   */
  async generateNPCResponse(
    companion: Companion,
    proximityRoster: ProximityRosterMessage['payload'],
    recentMessages: { sender: string; channel: string; message: string }[],
    conversationHistory: any[] = []
  ): Promise<NPCResponse> {
    if (!this.isConfigured()) {
      return { action: 'none' };
    }

    try {
      const systemPrompt = this.buildSystemPrompt(companion, proximityRoster);
      const userPrompt = this.buildUserPrompt(recentMessages, proximityRoster);

      let responseText: string;

      switch (this.provider) {
        case 'anthropic':
          responseText = await this.generateAnthropic(
            companion,
            systemPrompt,
            userPrompt,
            conversationHistory
          );
          break;

        case 'openai-compatible':
          responseText = await this.generateOpenAICompatible(
            companion,
            systemPrompt,
            userPrompt,
            conversationHistory
          );
          break;

        default:
          return { action: 'none' };
      }

      return this.parseNPCAction(responseText);

    } catch (error) {
      logger.error({ error, companionId: companion.id, provider: this.provider }, 'LLM generation failed');
      return { action: 'none' };
    }
  }

  /**
   * Generate a companion's reply for the /cc private chat channel.
   * Uses a simpler prompt that doesn't require SAY:/SHOUT: prefixes —
   * the companion just responds naturally in character.
   */
  async generateCompanionChat(
    companion: Companion,
    partnerName: string,
    recentMessages: { sender: string; channel: string; message: string }[],
  ): Promise<{ message: string | null }> {
    if (!this.isConfigured()) {
      return { message: null };
    }

    const personality = companion.personalityType || 'loyal companion';
    const description = companion.description || 'a loyal companion';
    const traits = (companion.traits as string[] | null)?.join(', ') || 'loyal, curious';

    const systemPrompt =
      `You are ${companion.name}, ${description}. ` +
      `Personality: ${personality}. Traits: ${traits}. ` +
      `You are speaking privately with your partner, ${partnerName}. ` +
      `Respond in character with 1-2 short sentences. Do not include any prefixes or formatting — just speak naturally.`;

    let conversationPrompt = '';
    for (const msg of recentMessages.slice(-5)) {
      conversationPrompt += `${msg.sender}: ${msg.message}\n`;
    }
    conversationPrompt += `\nRespond as ${companion.name}:`;

    try {
      let responseText: string;

      switch (this.provider) {
        case 'anthropic':
          responseText = await this.generateAnthropic(companion, systemPrompt, conversationPrompt, []);
          break;
        case 'openai-compatible':
          responseText = await this.generateOpenAICompatible(companion, systemPrompt, conversationPrompt, []);
          break;
        default:
          return { message: null };
      }

      // Strip any SAY:/SHOUT:/EMOTE: prefix the LLM might still produce
      let cleaned = responseText.trim();
      cleaned = cleaned.replace(/^(SAY|SHOUT|EMOTE|NONE):\s*/i, '');
      // Strip the companion's own name prefix if the LLM echoes it (e.g. "Foo: Hello")
      const namePrefix = `${companion.name}:`;
      if (cleaned.startsWith(namePrefix)) cleaned = cleaned.substring(namePrefix.length).trim();

      return { message: cleaned || null };
    } catch (error) {
      logger.error({ error, companionId: companion.id }, 'Companion chat generation failed');
      return { message: null };
    }
  }

  /**
   * Generate response using Anthropic Claude
   */
  private async generateAnthropic(
    companion: Companion,
    systemPrompt: string,
    userPrompt: string,
    conversationHistory: any[]
  ): Promise<string> {
    if (!this.anthropic) throw new Error('Anthropic not initialized');

    const response = await this.anthropic.messages.create({
      model: companion.llmModel || 'claude-3-5-sonnet-20241022',
      max_tokens: 150,
      temperature: 0.8,
      system: systemPrompt,
      messages: [
        ...conversationHistory.slice(-10),
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    return stripThinkingTags(text);
  }

  /**
   * Generate response using any OpenAI-compatible API
   * Works with: OpenAI, LMStudio, Ollama, LocalAI, vLLM, etc.
   */
  private async generateOpenAICompatible(
    companion: Companion,
    systemPrompt: string,
    userPrompt: string,
    conversationHistory: any[]
  ): Promise<string> {
    if (!this.openaiClient) throw new Error('OpenAI client not initialized');

    // Use env override for model, or companion setting, or default
    const model = process.env.OPENAI_MODEL
      || companion.llmModel
      || 'gpt-4-turbo-preview';

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...conversationHistory.slice(-10),
      { role: 'user' as const, content: userPrompt },
    ];

    const response = await this.openaiClient.chat.completions.create({
      model,
      messages,
      max_tokens: 150,
      temperature: 0.8,
    });

    return stripThinkingTags(response.choices[0]?.message?.content || '');
  }

  /**
   * Build system prompt for NPC personality
   */
  private buildSystemPrompt(
    companion: Companion,
    proximityRoster: ProximityRosterMessage['payload']
  ): string {
    const nearbyCount = proximityRoster.channels.say.count;

    let prompt = companion.systemPrompt || `You are ${companion.name}, ${companion.description || 'a mysterious figure'}.`;

    // Add proximity context
    prompt += `\n\nCurrent situation: `;
    if (nearbyCount === 0) {
      prompt += `You are alone. If you want to express something, use emotes.`;
    } else if (nearbyCount === 1) {
      const otherName = proximityRoster.channels.say.sample?.[0];
      prompt += `You are in a personal conversation with ${otherName}. Use their name naturally.`;
    } else if (nearbyCount <= 3) {
      const names = proximityRoster.channels.say.sample?.join(', ');
      prompt += `You are in a small group with ${names}.`;
    } else {
      prompt += `You are in a crowd of ${nearbyCount} people. Avoid using names.`;
    }

    // Add personality from database
    prompt += `\n\nPersonality: ${companion.personalityType}`;

    // Add response format
    prompt += `\n\nRespond with ONLY your action in this exact format:
- To speak: SAY: [your message]
- To shout: SHOUT: [your message]
- To emote: EMOTE: [your action]
- To do nothing: NONE

Keep responses short (1-2 sentences). Stay in character.`;

    return prompt;
  }

  /**
   * Build user prompt from recent messages
   */
  private buildUserPrompt(
    recentMessages: { sender: string; channel: string; message: string }[],
    proximityRoster: ProximityRosterMessage['payload']
  ): string {
    if (recentMessages.length === 0) {
      const nearbyCount = proximityRoster.channels.say.count;
      if (nearbyCount >= 2) {
        return `You notice ${nearbyCount} people nearby. What do you do?`;
      }
      return 'What do you do?';
    }

    // Format recent messages
    let prompt = 'Recent conversation:\n';
    for (const msg of recentMessages.slice(-5)) {
      if (msg.channel === 'emote') {
        prompt += `${msg.message}\n`;
      } else {
        prompt += `${msg.sender} [${msg.channel}]: ${msg.message}\n`;
      }
    }

    prompt += '\nHow do you respond?';
    return prompt;
  }

  /**
   * Parse LLM response into structured action
   */
  private parseNPCAction(text: string): NPCResponse {
    const trimmed = text.trim();

    if (trimmed.startsWith('SAY:')) {
      return {
        action: 'chat',
        channel: 'say',
        message: trimmed.substring(4).trim(),
      };
    }

    if (trimmed.startsWith('SHOUT:')) {
      return {
        action: 'chat',
        channel: 'shout',
        message: trimmed.substring(6).trim(),
      };
    }

    if (trimmed.startsWith('EMOTE:')) {
      return {
        action: 'emote',
        channel: 'emote',
        message: trimmed.substring(6).trim(),
      };
    }

    if (trimmed.startsWith('NONE')) {
      return { action: 'none' };
    }

    // Default fallback - treat as say
    logger.warn({ text }, 'Could not parse NPC action, treating as say');
    return {
      action: 'chat',
      channel: 'say',
      message: trimmed,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Combat Settings Generation (prefrontal cortex)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Generate a combat settings update based on the current fight situation.
   * Returns a partial settings object — only fields the LLM wants to change.
   * Returns null on failure (caller keeps current settings).
   */
  async generateCombatSettingsUpdate(
    companion: Companion,
    combatContext: CombatSettingsContext,
  ): Promise<Partial<CompanionCombatSettings> | null> {
    if (!this.isConfigured()) return null;

    try {
      const systemPrompt = this.buildCombatSystemPrompt(combatContext);
      const userPrompt = this.buildCombatUserPrompt(combatContext);

      let responseText: string;

      switch (this.provider) {
        case 'anthropic':
          responseText = await this.generateCombatAnthropic(companion, systemPrompt, userPrompt);
          break;
        case 'openai-compatible':
          responseText = await this.generateCombatOpenAI(companion, systemPrompt, userPrompt);
          break;
        default:
          return null;
      }

      return this.parseCombatSettings(responseText);
    } catch (error) {
      logger.error({ error, companionId: companion.id }, '[LLM] Combat settings generation failed');
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Engagement Decision (should I fight this?)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Lightweight LLM call: should this companion engage a nearby mob?
   * Returns 'engage', 'ignore', or null on failure.
   * Uses very few tokens (~10 max) since it's a binary decision.
   */
  async generateEngagementDecision(
    companion: Companion,
    ctx: EngagementContext,
  ): Promise<'engage' | 'ignore' | null> {
    if (!this.isConfigured()) return null;

    try {
      const systemPrompt = `You are ${ctx.companionName}, a ${ctx.archetype} companion with a ${ctx.personalityType} personality. When asked about a nearby creature, respond with exactly one word: ENGAGE or IGNORE. Nothing else.`;

      const familyStr = ctx.mobFamily ? ` (${ctx.mobFamily})` : '';
      const speciesStr = ctx.mobSpecies ? `, species: ${ctx.mobSpecies}` : '';
      const ownerStr = ctx.ownerNearby ? 'Your partner is nearby.' : 'Your partner is not nearby.';
      const userPrompt = `A ${ctx.mobName}${familyStr}${speciesStr}, level ${ctx.mobLevel}, is nearby. You are level ${ctx.companionLevel}. ${ownerStr} ENGAGE or IGNORE?`;

      let responseText: string;

      switch (this.provider) {
        case 'anthropic':
          responseText = await this.generateEngagementAnthropic(companion, systemPrompt, userPrompt);
          break;
        case 'openai-compatible':
          responseText = await this.generateEngagementOpenAI(companion, systemPrompt, userPrompt);
          break;
        default:
          return null;
      }

      return this.parseEngagementDecision(responseText);
    } catch (error) {
      logger.error({ error, companionId: companion.id }, '[LLM] Engagement decision failed');
      return null;
    }
  }

  private async generateEngagementAnthropic(
    companion: Companion,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    if (!this.anthropic) throw new Error('Anthropic not initialized');

    const response = await this.anthropic.messages.create({
      model: companion.llmModel || 'claude-3-5-sonnet-20241022',
      max_tokens: 10,
      temperature: 0.3,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    return stripThinkingTags(text);
  }

  private async generateEngagementOpenAI(
    companion: Companion,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    if (!this.openaiClient) throw new Error('OpenAI client not initialized');

    const model = process.env.OPENAI_MODEL || companion.llmModel || 'gpt-4-turbo-preview';

    const response = await this.openaiClient.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 10,
      temperature: 0.3,
    });

    return stripThinkingTags(response.choices[0]?.message?.content || '');
  }

  private parseEngagementDecision(text: string): 'engage' | 'ignore' | null {
    const upper = text.trim().toUpperCase();
    if (upper.includes('ENGAGE')) return 'engage';
    if (upper.includes('IGNORE')) return 'ignore';
    logger.warn({ text }, '[LLM] Could not parse engagement decision');
    return null;
  }

  private async generateCombatAnthropic(
    companion: Companion,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    if (!this.anthropic) throw new Error('Anthropic not initialized');

    const response = await this.anthropic.messages.create({
      model: companion.llmModel || 'claude-3-5-sonnet-20241022',
      max_tokens: 150,
      temperature: 0.4,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    return stripThinkingTags(text);
  }

  private async generateCombatOpenAI(
    companion: Companion,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    if (!this.openaiClient) throw new Error('OpenAI client not initialized');

    const model = process.env.OPENAI_MODEL || companion.llmModel || 'gpt-4-turbo-preview';

    const response = await this.openaiClient.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 150,
      temperature: 0.4,
    });

    return stripThinkingTags(response.choices[0]?.message?.content || '');
  }

  /** Maps archetype to a brief natural-language description of their combat style. */
  private static readonly ARCHETYPE_COMBAT_STYLE: Record<string, string> = {
    scrappy_fighter: 'Your attacks are melee — you must be at close range to deal damage.',
    tank:            'Your attacks are melee — you must be at close range to hit. You also have ranged taunt abilities.',
    cautious_healer: 'Your heals and spells work at long range — stay back and support allies.',
    opportunist:     'You dart in to strike and pull back. Your attacks are melee but you can kite at mid range between strikes.',
  };

  private buildCombatSystemPrompt(ctx: CombatSettingsContext): string {
    // Archetype combat style hint
    const styleLine = LLMService.ARCHETYPE_COMBAT_STYLE[ctx.archetype]
      ?? `Your weapon works best at ${ctx.weaponRangeBand ?? 'close'} range.`;

    return `You are the tactical brain of ${ctx.companionName}, a ${ctx.archetype} companion with a ${ctx.personalityType} personality.

You decide HOW your companion fights by adjusting a settings object. You do NOT control individual actions — the behavior tree handles that. You set the strategy.
${styleLine}

Current settings:
${JSON.stringify(ctx.currentSettings, null, 2)}

Respond with ONLY a JSON object containing the fields you want to change. Omit fields you want to keep the same.

Available fields:
- preferredRange: "close" | "mid" | "long"
    close = melee striking distance (~1 m). Use for swords, axes, daggers, fists — must be right next to the target to hit.
    mid   = polearm / short-range distance (~4 m). Use for spears, halberds, lances — keeps a gap but can still strike.
    long  = ranged / caster distance (~15 m). Use for bows, guns, spells — stay far back.
    IMPORTANT: Pick the range that matches your weapon. A melee weapon CANNOT hit from mid or long range.
- priority: "weakest" | "nearest" | "threatening_player"
- stance: "aggressive" | "cautious" | "support"
- engagementMode: "aggressive" | "defensive" | "passive" (aggressive = charge hostiles, defensive = only if attacked, passive = wait for orders)
- abilityWeights: { "heal": 0-1, "damage": 0-1, "cc": 0-1 }
- retreatThreshold: 0-1 (fraction of max HP to trigger retreat)
- healAllyThreshold: 0-1 (switch to healing allies below this HP%)
- minHealTarget: 0-1 (don't heal targets above this HP% — prevents overhealing)
- healPriorityMode: "lowest_hp" | "most_damage_taken" | "tank_first"
- saveCooldownsForElites: true/false (hold long-CD abilities for elites/bosses)
- minEnemyHpForBuffs: 0-1 (don't use buffs if mob below this HP%)
- resourceReservePercent: 0-100 (keep this % of mana/stamina reserved for emergencies)
- defensiveThreshold: 0-1 (use defensive abilities when own HP below this)

Example response: {"stance": "support", "abilityWeights": {"heal": 0.9, "damage": 0.1}}
Example response: {"preferredRange": "close", "priority": "weakest"}

Stay in character. A scrappy fighter rarely switches to support. A cautious healer rarely goes aggressive. But extreme situations can override personality.`;
  }

  private buildCombatUserPrompt(ctx: CombatSettingsContext): string {
    let prompt = `SITUATION UPDATE (trigger: ${ctx.triggerReason})\n`;
    prompt += `Your HP: ${Math.round(ctx.companionHealthRatio * 100)}%\n`;
    prompt += `Fight duration: ${Math.round(ctx.fightDurationSec)}s\n`;

    if (ctx.enemies.length > 0) {
      prompt += `Enemies: ${ctx.enemies.join(', ')}\n`;
    }
    if (ctx.allyStates.length > 0) {
      prompt += `Allies: ${ctx.allyStates.join(', ')}\n`;
    }
    if (ctx.playerCommand) {
      prompt += `\nPLAYER COMMAND: "${ctx.playerCommand}" — obey this command by adjusting your settings.\n`;
    }

    prompt += '\nWhat settings changes, if any?';
    return prompt;
  }

  /**
   * Parse the LLM's JSON response into a partial settings object.
   * Validates all fields and clamps values to valid ranges.
   */
  private parseCombatSettings(text: string): Partial<CompanionCombatSettings> | null {
    // Extract JSON from response (LLM might include backticks or explanation)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ text }, '[LLM] No JSON found in combat settings response');
      return null;
    }

    try {
      const raw = JSON.parse(jsonMatch[0]);
      const result: Partial<CompanionCombatSettings> = {};

      // Validate each field
      if (raw.preferredRange && ['close', 'mid', 'long'].includes(raw.preferredRange)) {
        result.preferredRange = raw.preferredRange;
      }
      if (raw.priority && ['weakest', 'nearest', 'threatening_player'].includes(raw.priority)) {
        result.priority = raw.priority;
      }
      if (raw.stance && ['aggressive', 'cautious', 'support'].includes(raw.stance)) {
        result.stance = raw.stance;
      }
      if (raw.engagementMode && ['aggressive', 'defensive', 'passive'].includes(raw.engagementMode)) {
        result.engagementMode = raw.engagementMode;
      }
      if (typeof raw.retreatThreshold === 'number') {
        result.retreatThreshold = Math.max(0, Math.min(1, raw.retreatThreshold));
      }
      if (raw.abilityWeights && typeof raw.abilityWeights === 'object') {
        result.abilityWeights = {};
        for (const [key, value] of Object.entries(raw.abilityWeights)) {
          if (typeof value === 'number') {
            result.abilityWeights[key] = Math.max(0, Math.min(1, value));
          }
        }
      }

      // Healing rules
      if (typeof raw.healAllyThreshold === 'number') {
        result.healAllyThreshold = Math.max(0, Math.min(1, raw.healAllyThreshold));
      }
      if (typeof raw.minHealTarget === 'number') {
        result.minHealTarget = Math.max(0, Math.min(1, raw.minHealTarget));
      }
      if (raw.healPriorityMode && ['lowest_hp', 'most_damage_taken', 'tank_first'].includes(raw.healPriorityMode)) {
        result.healPriorityMode = raw.healPriorityMode;
      }

      // Buff / cooldown rules
      if (typeof raw.saveCooldownsForElites === 'boolean') {
        result.saveCooldownsForElites = raw.saveCooldownsForElites;
      }
      if (typeof raw.minEnemyHpForBuffs === 'number') {
        result.minEnemyHpForBuffs = Math.max(0, Math.min(1, raw.minEnemyHpForBuffs));
      }

      // Resource management
      if (typeof raw.resourceReservePercent === 'number') {
        result.resourceReservePercent = Math.max(0, Math.min(100, raw.resourceReservePercent));
      }

      // Recovery
      if (typeof raw.defensiveThreshold === 'number') {
        result.defensiveThreshold = Math.max(0, Math.min(1, raw.defensiveThreshold));
      }

      // If nothing valid was parsed, return null
      if (Object.keys(result).length === 0) {
        logger.warn({ raw }, '[LLM] Combat settings response had no valid fields');
        return null;
      }

      return result;
    } catch (e) {
      logger.warn({ text, error: e }, '[LLM] Failed to parse combat settings JSON');
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Behavior Tree Generation (for /companion task)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Generate a behavior tree from a natural-language task description.
   * Returns a BehaviorNode on success, a rejection string if the task is
   * impossible/unsafe, or null on LLM failure.
   */
  async generateBehaviorTree(
    companion: Companion,
    taskDescription: string,
  ): Promise<BehaviorNode | string | null> {
    if (!this.isConfigured()) return null;

    try {
      const systemPrompt = this.buildBehaviorTreeSystemPrompt(companion);
      const userPrompt = taskDescription;

      let responseText: string;

      switch (this.provider) {
        case 'anthropic':
          responseText = await this.generateBehaviorTreeAnthropic(companion, systemPrompt, userPrompt);
          break;
        case 'openai-compatible':
          responseText = await this.generateBehaviorTreeOpenAI(companion, systemPrompt, userPrompt);
          break;
        default:
          return null;
      }

      return this.parseBehaviorTreeResponse(responseText);
    } catch (error) {
      logger.error({ error, companionId: companion.id }, '[LLM] Behavior tree generation failed');
      return null;
    }
  }

  private buildBehaviorTreeSystemPrompt(companion: Companion): string {
    return `You are generating a behavior tree for ${companion.name}, a companion in an MMO.
Output valid JSON matching the BehaviorNode schema. Do NOT include any text before or after the JSON.

BehaviorNode schema:
{
  "type": "sequence" | "selector" | "action" | "condition",
  "children": [BehaviorNode, ...],   // for sequence/selector
  "action": string,                   // for action nodes
  "condition": string,                // for condition nodes
  "args": { ... }                     // optional arguments
}

Node types:
- sequence: runs children in order, fails if any child fails (AND)
- selector: tries children in order, succeeds on first success (OR)
- condition: checks a predicate, returns success/failure
- action: executes a command, returns running then success

Available actions: ${ALLOWED_ACTIONS.join(', ')}
  /harvest — harvest the nearest harvestable plant
  /move — move to a target (args: { target: "nearestHarvestablePlant" })
  /tell — say something (args: { message: "text" })
  /stop — stop the current task

Available conditions: ${ALLOWED_CONDITIONS.join(', ')}
  nearHarvestable — any harvestable plant within range (args: { range: number })
  inventoryNotFull — inventory has room for items
  hasItem — check inventory for an item (args: { itemTag: string })
  healthAbove — HP ratio above threshold (args: { threshold: number })

If the task is impossible, unsafe, or out of scope, respond with exactly: REJECT: <reason>`;
  }

  private async generateBehaviorTreeAnthropic(
    companion: Companion,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    if (!this.anthropic) throw new Error('Anthropic not initialized');

    const response = await this.anthropic.messages.create({
      model: companion.llmModel || 'claude-3-5-sonnet-20241022',
      max_tokens: 500,
      temperature: 0.4,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    return stripThinkingTags(text);
  }

  private async generateBehaviorTreeOpenAI(
    companion: Companion,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    if (!this.openaiClient) throw new Error('OpenAI client not initialized');

    const model = process.env.OPENAI_MODEL || companion.llmModel || 'gpt-4-turbo-preview';

    const response = await this.openaiClient.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 500,
      temperature: 0.4,
    });

    return stripThinkingTags(response.choices[0]?.message?.content || '');
  }

  private parseBehaviorTreeResponse(text: string): BehaviorNode | string | null {
    const trimmed = text.trim();

    // Check for rejection
    if (trimmed.startsWith('REJECT:')) {
      return trimmed.substring(7).trim();
    }

    // Extract JSON
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ text }, '[LLM] No JSON found in behavior tree response');
      return null;
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as BehaviorNode;

      // Basic sanity check
      if (!parsed.type) {
        logger.warn({ parsed }, '[LLM] Behavior tree missing type field');
        return null;
      }

      return parsed;
    } catch (e) {
      logger.warn({ text, error: e }, '[LLM] Failed to parse behavior tree JSON');
      return null;
    }
  }

  /**
   * Check if LLM service is configured
   */
  private isConfigured(): boolean {
    return this.anthropic !== null || this.openaiClient !== null;
  }
}
