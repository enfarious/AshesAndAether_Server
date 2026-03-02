/**
 * /village command — village management (enter, leave, visit, place, remove, info, catalog, create)
 */

import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';
import { VillageService } from '@/village';

export const villageCommand: CommandDefinition = {
  name: 'village',
  aliases: ['v', 'georama'],
  description: 'Village management — enter, leave, place structures, and visit others',
  category: 'world',
  usage: '/village [enter|leave|visit|place|remove|info|catalog|create] [args]',
  examples: [
    '/village',
    '/village enter',
    '/village leave',
    '/village visit Kaito',
    '/village place market_stall',
    '/village remove',
    '/village info',
    '/village catalog',
    '/village create meadow_small',
  ],

  parameters: {
    positional: [
      { type: 'string', required: false, description: 'Subcommand' },
    ],
  },

  handler: async (context: CommandContext, args: ParsedCommand): Promise<CommandResult> => {
    const action = (args.positionalArgs[0] || 'enter').toLowerCase();
    const restArgs = args.positionalArgs.slice(1);

    switch (action) {
      case 'enter':   return handleEnter(context);
      case 'leave':   return handleLeave(context);
      case 'visit':   return handleVisit(context, restArgs);
      case 'place':   return handlePlace(context, restArgs);
      case 'remove':  return handleRemove(context);
      case 'info':    return handleInfo(context);
      case 'catalog': return handleCatalog();
      case 'create':  return handleCreate(context, restArgs);
      default:        return handleEnter(context);
    }
  },
};

async function handleEnter(context: CommandContext): Promise<CommandResult> {
  if (VillageService.isVillageZone(context.zoneId)) {
    return { success: false, error: 'You are already in a village. Use /village leave first.' };
  }

  const village = await VillageService.getVillage(context.characterId);
  if (!village) {
    return { success: false, error: "You don't have a village yet. Use /village create <template> to create one." };
  }

  return {
    success: true,
    message: `Entering ${village.name}...`,
    events: [{
      type: 'village_enter',
      data: { targetCharacterId: context.characterId },
    }],
  };
}

async function handleLeave(context: CommandContext): Promise<CommandResult> {
  if (!VillageService.isVillageZone(context.zoneId)) {
    return { success: false, error: 'You are not in a village.' };
  }
  return {
    success: true,
    message: 'Returning to the world...',
    events: [{ type: 'village_leave', data: {} }],
  };
}

async function handleVisit(context: CommandContext, args: string[]): Promise<CommandResult> {
  if (VillageService.isVillageZone(context.zoneId)) {
    return { success: false, error: 'Leave your current village first (/village leave).' };
  }
  const playerName = args.join(' ').trim();
  if (!playerName) {
    return { success: false, error: 'Usage: /village visit <playerName>' };
  }
  return {
    success: true,
    message: `Visiting ${playerName}'s village...`,
    events: [{
      type: 'village_enter',
      data: { targetCharacterId: null, targetPlayerName: playerName },
    }],
  };
}

async function handlePlace(context: CommandContext, args: string[]): Promise<CommandResult> {
  if (!VillageService.isVillageZone(context.zoneId)) {
    return { success: false, error: 'You must be in your village to place structures.' };
  }
  const ownerCharId = VillageService.extractOwnerCharacterId(context.zoneId);
  if (ownerCharId !== context.characterId) {
    return { success: false, error: 'You can only place structures in your own village.' };
  }
  const structureName = args[0];
  if (!structureName) {
    return { success: false, error: 'Usage: /village place <structureName>' };
  }

  const catalog = await VillageService.getCatalogByName(structureName);
  if (!catalog) {
    return { success: false, error: `Unknown structure '${structureName}'. Use /village catalog to see available structures.` };
  }

  const village = await VillageService.getVillage(context.characterId);
  if (!village) {
    return { success: false, error: 'Village not found.' };
  }

  return {
    success: true,
    message: `Entering placement mode for ${catalog.displayName}. Click to place, R to rotate, Escape to cancel.`,
    events: [{
      type: 'village_placement_mode',
      data: {
        catalogId: catalog.id,
        structureName: catalog.name,
        displayName: catalog.displayName,
        sizeX: catalog.sizeX,
        sizeZ: catalog.sizeZ,
        modelAsset: catalog.modelAsset,
        gridSize: village.template.gridSize,
        goldCost: catalog.goldCost,
      },
    }],
  };
}

async function handleRemove(context: CommandContext): Promise<CommandResult> {
  if (!VillageService.isVillageZone(context.zoneId)) {
    return { success: false, error: 'You must be in your village to remove structures.' };
  }
  const ownerCharId = VillageService.extractOwnerCharacterId(context.zoneId);
  if (ownerCharId !== context.characterId) {
    return { success: false, error: 'You can only remove structures in your own village.' };
  }
  if (!context.currentTarget) {
    return { success: false, error: 'Target a structure first, then use /village remove.' };
  }
  return {
    success: true,
    events: [{
      type: 'village_remove',
      data: { structureId: context.currentTarget },
    }],
  };
}

async function handleInfo(context: CommandContext): Promise<CommandResult> {
  const village = await VillageService.getVillage(context.characterId);
  if (!village) {
    return { success: false, error: "You don't have a village. Use /village create <template> to create one." };
  }
  const structLines = village.structures.length > 0
    ? village.structures.map(s => `  - ${s.catalog.displayName} at (${s.positionX}, ${s.positionZ})`).join('\n')
    : '  (none)';

  return {
    success: true,
    message: [
      `Village: ${village.name}`,
      `Template: ${village.template.name}`,
      `Structures: ${village.structures.length}/${village.template.maxStructures}`,
      structLines,
    ].join('\n'),
  };
}

async function handleCatalog(): Promise<CommandResult> {
  const catalog = await VillageService.getCatalog();
  if (catalog.length === 0) {
    return { success: true, message: 'No structures available.' };
  }
  const lines = catalog.map(c =>
    `  ${c.name} — ${c.displayName} (${c.goldCost}g, ${c.sizeX}x${c.sizeZ}, max ${c.maxPerVillage})`
  );
  return {
    success: true,
    message: ['Available structures:', ...lines].join('\n'),
  };
}

async function handleCreate(context: CommandContext, args: string[]): Promise<CommandResult> {
  if (context.isGuest) {
    return { success: false, error: 'Guest accounts cannot create villages. Register an account first!' };
  }

  const templateName = args[0];
  if (!templateName) {
    const templates = await VillageService.getTemplates();
    const lines = templates.map(t => `  ${t.name} — ${t.description ?? '(no description)'}`);
    return {
      success: true,
      message: ['Usage: /village create <templateName>', 'Available templates:', ...lines].join('\n'),
    };
  }

  const villageName = args.slice(1).join(' ').trim() || undefined;
  try {
    const village = await VillageService.createVillage(context.characterId, templateName, villageName);
    return {
      success: true,
      message: `Village "${village.name}" created! Use /village enter to visit it.`,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
