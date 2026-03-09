/**
 * /gm — Game Master tools.
 *
 * Subcommands:
 *   /gm give <tag> [quantity]      — award item(s) by ItemTag to yourself
 *   /gm giveto <player> <tag> [q]  — award item(s) to another player
 *   /gm gold <amount>              — add gold to your wallet
 *   /gm level <level>              — set your character level
 *   /gm heal                       — full heal (HP / stamina / mana)
 *   /gm items [search]             — list available item tags
 *   /gm promote <player> <role>    — set a player's account role
 *   /gm gate                       — open the next closed vault gate
 *
 * All subcommands require the 'gm' permission (account.role = 'gm' | 'admin').
 */

import type { CommandDefinition } from '../../types';
import { prisma } from '@/database/DatabaseService';
import { InventoryService } from '@/database/services/InventoryService';
import { WalletService } from '@/database/services/WalletService';
import { CharacterService } from '@/database/services/CharacterService';
import { StatCalculator } from '@/game/stats/StatCalculator';
import { getVaultManager } from '../world/vault-command';
import { logger } from '@/utils/logger';

export const gmCommand: CommandDefinition = {
  name: 'gm',
  aliases: ['admin'],
  description: 'Game Master tools — item grants, gold, leveling, healing',
  category: 'system',
  permissions: ['gm'],
  usage: '/gm <subcommand> [args]',
  examples: [
    '/gm give vault_fragment_lab 3',
    '/gm giveto Aeris vault_key_lab',
    '/gm gold 5000',
    '/gm level 10',
    '/gm heal',
    '/gm items vault',
    '/gm promote Aeris gm',
  ],

  handler: async (context, args) => {
    const sub = args.positionalArgs[0]?.toLowerCase();
    if (!sub) {
      return {
        success: false,
        error:
          'Usage: /gm <give|giveto|gold|level|heal|items|promote|gate>\n' +
          '  give <tag> [qty]        — give item by tag\n' +
          '  giveto <player> <tag> [qty]\n' +
          '  gold <amount>\n' +
          '  level <level>\n' +
          '  heal\n' +
          '  items [search]\n' +
          '  promote <player> <role>\n' +
          '  gate                    — open next vault gate',
      };
    }

    switch (sub) {

      // ── /gm give <tag> [quantity] ─────────────────────────────────────────
      case 'give': {
        const tag = args.positionalArgs[1];
        const qty = Math.max(1, parseInt(args.positionalArgs[2] ?? '1', 10) || 1);
        if (!tag) return { success: false, error: 'Usage: /gm give <tag> [quantity]' };

        const item = await InventoryService.addItemByTemplateTag(context.characterId, tag, qty);
        if (!item) {
          return { success: false, error: `No item template found for tag "${tag}". Use /gm items to search.` };
        }

        return {
          success: true,
          message: `[GM] Granted ${qty}× ${item.name}`,
          events: [{ type: 'gm_inventory_refresh', data: { characterId: context.characterId } }],
        };
      }

      // ── /gm giveto <player> <tag> [quantity] ─────────────────────────────
      case 'giveto': {
        const targetName = args.positionalArgs[1];
        const tag        = args.positionalArgs[2];
        const qty        = Math.max(1, parseInt(args.positionalArgs[3] ?? '1', 10) || 1);
        if (!targetName || !tag) return { success: false, error: 'Usage: /gm giveto <player> <tag> [quantity]' };

        const target = await CharacterService.findByName(targetName);
        if (!target) return { success: false, error: `Player "${targetName}" not found.` };

        const item = await InventoryService.addItemByTemplateTag(target.id, tag, qty);
        if (!item) return { success: false, error: `No item template found for tag "${tag}".` };

        return {
          success: true,
          message: `[GM] Granted ${qty}× ${item.name} to ${target.name}`,
          events: [{ type: 'gm_inventory_refresh', data: { characterId: target.id } }],
        };
      }

      // ── /gm gold <amount> ────────────────────────────────────────────────
      case 'gold': {
        const amount = parseInt(args.positionalArgs[1] ?? '', 10);
        if (!amount || amount < 1) return { success: false, error: 'Usage: /gm gold <amount> (positive integer)' };

        const result = await WalletService.addGold(context.characterId, amount, 'gm_grant');
        return {
          success: true,
          message: `[GM] Added ${amount}g — balance: ${result.newBalance}g`,
        };
      }

      // ── /gm level <level> ────────────────────────────────────────────────
      case 'level': {
        const level = parseInt(args.positionalArgs[1] ?? '', 10);
        if (!level || level < 1 || level > 100) {
          return { success: false, error: 'Usage: /gm level <1–100>' };
        }

        const character = await CharacterService.findById(context.characterId);
        if (!character) return { success: false, error: 'Character not found.' };

        // Compute derived stats for the new level
        const coreStats = {
          strength:     character.strength,
          vitality:     character.vitality,
          dexterity:    character.dexterity,
          agility:      character.agility,
          intelligence: character.intelligence,
          wisdom:       character.wisdom,
        };
        const derived = StatCalculator.calculateDerivedStats(coreStats, level);

        await prisma.character.update({
          where: { id: context.characterId },
          data: {
            level,
            maxHp:      derived.maxHp,
            maxStamina: derived.maxStamina,
            maxMana:    derived.maxMana,
            currentHp:  derived.maxHp,
            currentStamina: derived.maxStamina,
            currentMana:    derived.maxMana,
            attackRating:   derived.attackRating,
            defenseRating:  derived.defenseRating,
            magicAttack:    derived.magicAttack,
            magicDefense:   derived.magicDefense,
          },
        });

        return {
          success: true,
          message: `[GM] Level set to ${level} — HP: ${derived.maxHp}, Stamina: ${derived.maxStamina}, Mana: ${derived.maxMana}`,
          events: [{ type: 'gm_state_refresh', data: { characterId: context.characterId } }],
        };
      }

      // ── /gm heal ─────────────────────────────────────────────────────────
      case 'heal': {
        const character = await CharacterService.findById(context.characterId);
        if (!character) return { success: false, error: 'Character not found.' };

        await prisma.character.update({
          where: { id: context.characterId },
          data: {
            currentHp:      character.maxHp,
            currentStamina: character.maxStamina,
            currentMana:    character.maxMana,
            isAlive:        true,
          },
        });

        return {
          success: true,
          message: `[GM] Fully healed — HP: ${character.maxHp}, Stam: ${character.maxStamina}, Mana: ${character.maxMana}`,
          events: [{ type: 'gm_state_refresh', data: { characterId: context.characterId } }],
        };
      }

      // ── /gm items [search] ───────────────────────────────────────────────
      case 'items': {
        const search = args.positionalArgs.slice(1).join(' ');
        const where = search
          ? { name: { contains: search, mode: 'insensitive' as const } }
          : {};

        const tags = await prisma.itemTag.findMany({
          where,
          take: 30,
          orderBy: { name: 'asc' },
          include: {
            templates: {
              take: 1,
              include: { itemTemplate: { select: { name: true } } },
            },
          },
        });

        if (tags.length === 0) {
          return { success: true, message: `[GM] No item tags found${search ? ` matching "${search}"` : ''}.` };
        }

        const lines = tags.map(t => {
          const templateName = t.templates[0]?.itemTemplate.name ?? '(no template)';
          return `  ${t.name} → ${templateName}`;
        });

        return {
          success: true,
          message: `[GM] Item tags${search ? ` matching "${search}"` : ''} (${tags.length}):\n${lines.join('\n')}`,
        };
      }

      // ── /gm promote <player> <role> ──────────────────────────────────────
      case 'promote': {
        const targetName = args.positionalArgs[1];
        const role       = args.positionalArgs[2]?.toLowerCase();
        if (!targetName || !role) return { success: false, error: 'Usage: /gm promote <player> <gm|player|admin>' };
        if (!['player', 'gm', 'admin'].includes(role)) {
          return { success: false, error: 'Valid roles: player, gm, admin' };
        }

        const target = await CharacterService.findByName(targetName);
        if (!target) return { success: false, error: `Player "${targetName}" not found.` };

        await prisma.account.update({
          where: { id: target.accountId },
          data:  { role },
        });

        logger.info(
          { promoter: context.characterName, target: targetName, role },
          '[GM] Account role changed',
        );

        return {
          success: true,
          message: `[GM] Set ${targetName}'s account role to "${role}"`,
        };
      }

      // ── /gm gate ──────────────────────────────────────────────────────────
      case 'gate': {
        const msg = getVaultManager().gmOpenNextGate(context.characterId);
        return { success: true, message: msg };
      }

      default:
        return {
          success: false,
          error: `Unknown GM subcommand "${sub}". Use: give, giveto, gold, level, heal, items, promote, gate`,
        };
    }
  },
};
