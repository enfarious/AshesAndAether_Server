/**
 * Command executor - validates and executes slash commands
 */

import { RedisClientType } from 'redis';
import { logger } from '@/utils/logger';
import { CommandRegistry } from './CommandRegistry';
import { CommandParser } from './CommandParser';
import type {
  CommandContext,
  CommandResult,
  ParsedCommand,
} from './types';

export class CommandExecutor {
  private registry: CommandRegistry;
  private parser: CommandParser;
  private redis: RedisClientType;

  // Cooldown tracking (Redis keys: `cooldown:${characterId}:${commandName}`)
  private readonly COOLDOWN_PREFIX = 'cooldown';

  constructor(registry: CommandRegistry, parser: CommandParser, redis: RedisClientType) {
    this.registry = registry;
    this.parser = parser;
    this.redis = redis;
  }

  /**
   * Execute a slash command
   */
  async execute(rawCommand: string, context: CommandContext): Promise<CommandResult> {
    try {
      // Parse command string
      const parsed = this.parser.parse(rawCommand);
      this.parser.validate(parsed);
      logger.debug(
        { rawCommand, parsed, characterId: context.characterId, zoneId: context.zoneId },
        'Command parsed'
      );

      // Lookup command definition
      const definition = this.registry.get(parsed.command);
      if (!definition) {
        const suggestions = this.parser.suggestCommand(
          parsed.command,
          this.registry.getAllNames()
        );
        logger.warn(
          { rawCommand, command: parsed.command, suggestions, characterId: context.characterId },
          'Unknown command'
        );

        return {
          success: false,
          error: `Unknown command '/${parsed.command}'${
            suggestions.length > 0 ? `. Did you mean: ${suggestions.map(s => `/${s}`).join(', ')}?` : ''
          }`,
        };
      }

      // Check permissions
      if (definition.permissions && definition.permissions.length > 0) {
        const hasPermission = await this.checkPermissions(context, definition.permissions);
        if (!hasPermission) {
          logger.warn(
            { command: definition.name, characterId: context.characterId },
            'Command permission denied'
          );
          return {
            success: false,
            error: 'You do not have permission to use this command.',
          };
        }
      }

      // Check cooldown
      if (definition.cooldown && definition.cooldown > 0) {
        const cooldownRemaining = await this.getCooldownRemaining(
          context.characterId,
          definition.name
        );

        if (cooldownRemaining > 0) {
          logger.debug(
            { command: definition.name, cooldownRemaining, characterId: context.characterId },
            'Command on cooldown'
          );
          return {
            success: false,
            error: `Command on cooldown (${(cooldownRemaining / 1000).toFixed(1)}s remaining)`,
          };
        }
      }

      // Check target requirement
      if (definition.requiresTarget && !context.currentTarget && parsed.positionalArgs.length === 0) {
        logger.debug(
          { command: definition.name, characterId: context.characterId },
          'Command missing required target'
        );
        return {
          success: false,
          error: 'This command requires a target. Use /target <entity> or provide a target argument.',
        };
      }

      // Validate parameters (basic type checking)
      const validationError = this.validateParameters(parsed, definition);
      if (validationError) {
        logger.debug(
          { command: definition.name, error: validationError, characterId: context.characterId },
          'Command validation failed'
        );
        return {
          success: false,
          error: validationError,
        };
      }

      // Execute command handler
      const result = await definition.handler(context, parsed);
      logger.debug(
        {
          command: definition.name,
          success: result.success,
          characterId: context.characterId,
          hasEvents: Boolean(result.events?.length),
        },
        'Command executed'
      );

      // Set cooldown if command succeeded
      if (result.success && definition.cooldown && definition.cooldown > 0) {
        await this.setCooldown(context.characterId, definition.name, definition.cooldown);
      }

      return result;

    } catch (error) {
      logger.error({ error, rawCommand, context }, 'Command execution error');

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Command execution failed',
      };
    }
  }

  /**
   * Check if character has required permissions
   */
  private async checkPermissions(
    _context: CommandContext,
    _requiredPermissions: string[]
  ): Promise<boolean> {
    // TODO: Implement permission system
    // For now, all commands are allowed
    return true;
  }

  /**
   * Get remaining cooldown time in milliseconds
   * Returns 0 if no cooldown active
   */
  private async getCooldownRemaining(
    characterId: string,
    commandName: string
  ): Promise<number> {
    const key = `${this.COOLDOWN_PREFIX}:${characterId}:${commandName}`;

    try {
      const expiresAt = await this.redis.get(key);
      if (!expiresAt) return 0;

      const remaining = parseInt(expiresAt, 10) - Date.now();
      return remaining > 0 ? remaining : 0;

    } catch (error) {
      logger.error({ error, characterId, commandName }, 'Failed to check cooldown');
      return 0;  // Allow command on Redis error
    }
  }

  /**
   * Set cooldown for a command
   * Stores expiration timestamp in Redis
   */
  private async setCooldown(
    characterId: string,
    commandName: string,
    cooldownMs: number
  ): Promise<void> {
    const key = `${this.COOLDOWN_PREFIX}:${characterId}:${commandName}`;
    const expiresAt = Date.now() + cooldownMs;

    try {
      // Store expiration timestamp, auto-expire key after cooldown
      await this.redis.set(key, expiresAt.toString(), {
        PX: cooldownMs,  // Auto-expire in milliseconds
      });
    } catch (error) {
      logger.error({ error, characterId, commandName }, 'Failed to set cooldown');
      // Non-critical error, command already executed
    }
  }

  /**
   * Validate command parameters (basic checks)
   */
  private validateParameters(parsed: ParsedCommand, definition: any): string | null {
    // Check required positional parameters
    if (definition.parameters?.positional) {
      for (let i = 0; i < definition.parameters.positional.length; i++) {
        const param = definition.parameters.positional[i];
        if (param.required !== false && !parsed.positionalArgs[i]) {
          return `Missing required parameter: ${param.description || `argument ${i + 1}`}`;
        }
      }
    }

    // Check required named parameters
    if (definition.parameters?.named) {
      for (const [key, param] of Object.entries(definition.parameters.named) as any) {
        if (param.required && !parsed.namedArgs[key]) {
          return `Missing required parameter: ${key}`;
        }
      }
    }

    return null;
  }
}
