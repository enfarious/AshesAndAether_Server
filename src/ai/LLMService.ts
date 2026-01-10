import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { logger } from '@/utils/logger';
import type { Companion } from '@prisma/client';
import type { ProximityRosterMessage } from '@/network/protocol/types';

interface NPCResponse {
  action: 'chat' | 'emote' | 'none';
  channel?: 'say' | 'shout' | 'emote';
  message?: string;
}

type LLMProvider = 'anthropic' | 'openai-compatible';

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

    return response.content[0].type === 'text' ? response.content[0].text : '';
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

    return response.choices[0]?.message?.content || '';
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

  /**
   * Check if LLM service is configured
   */
  private isConfigured(): boolean {
    return this.anthropic !== null || this.openaiClient !== null;
  }
}
