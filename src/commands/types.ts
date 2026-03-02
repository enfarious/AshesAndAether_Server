/**
 * Slash command system types
 */

import type { Vector3 } from '@/network/protocol/types';

// ========== Parsed Command ==========

export interface ParsedCommand {
  command: string;                          // "attack"
  positionalArgs: string[];                 // ["ant.worker.1"]
  namedArgs: Record<string, string>;        // { power: "max" }
  rawInput: string;                         // Original input
}

// ========== Parameter Definitions ==========

export type ParameterType = 'string' | 'number' | 'entity' | 'boolean' | 'enum';

export interface ParameterDef {
  type: ParameterType;
  required?: boolean;
  default?: any;
  description?: string;
  validation?: (value: any) => boolean;
  enumValues?: string[];  // For enum type
}

// ========== Command Definition ==========

export interface CommandDefinition {
  name: string;
  aliases?: string[];
  description: string;
  category: CommandCategory;
  usage?: string;  // Example usage string
  examples?: string[];  // Example commands

  parameters?: {
    positional?: ParameterDef[];
    named?: Record<string, ParameterDef>;
  };

  permissions?: string[];  // Required permissions
  cooldown?: number;       // Milliseconds between uses
  requiresTarget?: boolean;  // Must have target selected

  handler: CommandHandler;
}

export type CommandCategory =
  | 'movement'
  | 'combat'
  | 'social'
  | 'inventory'
  | 'character'
  | 'world'
  | 'system';

// ========== Command Context ==========

export interface CommandContext {
  // Character info
  characterId: string;
  characterName: string;
  accountId: string;

  // Location
  zoneId: string;
  position: Vector3;
  heading: number;

  // State
  inCombat: boolean;
  currentTarget?: string;  // Entity ID
  focusTarget?: string;    // Entity ID

  // Communication
  socketId: string;

  // Account flags
  isGuest?: boolean;
}

// ========== Command Result ==========

export interface CommandResult {
  success: boolean;
  message?: string;
  error?: string;
  data?: any;

  // Optional effects
  events?: CommandEvent[];  // Game events triggered
  broadcast?: boolean;      // Broadcast to nearby players
}

export interface CommandEvent {
  type: string;
  data: any;
}

// ========== Command Handler ==========

export type CommandHandler = (
  context: CommandContext,
  args: ParsedCommand
) => Promise<CommandResult> | CommandResult;

// ========== Command Error ==========

export class CommandError extends Error {
  constructor(
    message: string,
    public code: CommandErrorCode,
    public suggestions?: string[]
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

export enum CommandErrorCode {
  UNKNOWN_COMMAND = 'UNKNOWN_COMMAND',
  INVALID_SYNTAX = 'INVALID_SYNTAX',
  MISSING_PARAMETER = 'MISSING_PARAMETER',
  INVALID_PARAMETER = 'INVALID_PARAMETER',
  OUT_OF_RANGE = 'OUT_OF_RANGE',
  NO_TARGET = 'NO_TARGET',
  ON_COOLDOWN = 'ON_COOLDOWN',
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',
  IN_COMBAT = 'IN_COMBAT',
  NOT_IN_COMBAT = 'NOT_IN_COMBAT',
  INVALID_STATE = 'INVALID_STATE',
}

// ========== Auto-Completion ==========

export interface CompletionSuggestion {
  value: string;
  description?: string;
  category?: string;
  score?: number;  // For ranking
}

export interface CompletionRequest {
  input: string;
  cursorPosition: number;
  context: CommandContext;
}

// ========== Command Response (Protocol Message) ==========

export interface CommandResponseMessage {
  type: 'command_response';
  payload: {
    success: boolean;
    command: string;  // Echo original command
    message?: string;
    error?: string;
    data?: any;
    timestamp: number;
  };
}
