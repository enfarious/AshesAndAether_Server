/**
 * /market command - Market operations (list, buy, cancel, search, myorders, wallet)
 */

import { prisma } from '@/database';
import { WalletService } from '@/database/services/WalletService';
import { VillageService } from '@/village';
import type { MarketStall } from '@prisma/client';
import type { CommandDefinition, CommandContext, CommandResult, ParsedCommand } from '@/commands/types';

const MARKET_STALL_RANGE = 20; // meters

export const marketCommand: CommandDefinition = {
  name: 'market',
  aliases: ['m', 'auction', 'trade'],
  description: 'Manage market orders and trading',
  category: 'world',
  usage: '/market <list|buy|cancel|search|stall|myorders|wallet> [args]',
  examples: [
    '/market list "Iron Sword" 100',
    '/market list "Iron Sword" 100 world',
    '/market buy abc123',
    '/market cancel abc123',
    '/market search sword',
    '/market search iron regional',
    '/market stall',
    '/market myorders',
    '/market wallet',
  ],

  parameters: {
    positional: [
      { type: 'string', required: true, description: 'Action (list/buy/cancel/search/myorders/wallet)' },
    ],
  },

  handler: async (context: CommandContext, args: ParsedCommand): Promise<CommandResult> => {
    const action = (args.positionalArgs[0] || '').toLowerCase();
    const restArgs = args.positionalArgs.slice(1);

    // Wallet, orders, and help don't require stall proximity
    switch (action) {
      case 'wallet':
      case 'gold':
      case 'balance':
        return handleWallet(context);

      case 'myorders':
      case 'orders':
        return handleMyOrders(context);
    }

    // All trade actions require proximity to a market stall
    const nearbyStall = await VillageService.findNearbyStall(
      context.zoneId,
      context.position,
      MARKET_STALL_RANGE,
    );

    if (!nearbyStall) {
      return {
        success: false,
        error: 'You must be near a market stall to trade. Find one in a town or place one in your village.',
      };
    }

    switch (action) {
      case 'list':
      case 'sell':
        return handleList(context, restArgs, nearbyStall);

      case 'buy':
      case 'purchase':
        return handleBuy(context, restArgs);

      case 'cancel':
        return handleCancel(context, restArgs);

      case 'search':
      case 'find':
        return handleSearch(context, restArgs, nearbyStall);

      case 'stall':
        return handleStall(nearbyStall);

      case 'help':
      default:
        return {
          success: true,
          message: `Market Commands:
  /market list "<item>" <price> [world] - List item for sale
  /market buy <order_id> [quantity] - Buy from a listing
  /market cancel <order_id> - Cancel your listing
  /market search <item_name> [regional|world] - Search listings
  /market stall - View nearby market stall info
  /market myorders - View your active orders
  /market wallet - Check your gold balance`,
        };
    }
  },
};

/**
 * Handle /market list - List an item for sale
 */
async function handleList(context: CommandContext, args: string[], nearbyStall: MarketStall): Promise<CommandResult> {
  // Parse: itemName price [scope]
  // Item name may be quoted
  const parsed = parseListArgs(args);
  if (!parsed) {
    return {
      success: false,
      error: 'Usage: /market list "<item name>" <price> [world]\nExample: /market list "Iron Sword" 100',
    };
  }

  const { itemName, price, scope } = parsed;

  if (price < 1) {
    return { success: false, error: 'Price must be at least 1 gold.' };
  }

  // Find the item in inventory
  const item = await prisma.inventoryItem.findFirst({
    where: {
      characterId: context.characterId,
      equipped: false,
      template: { name: { equals: itemName, mode: 'insensitive' } },
    },
    include: { template: true },
  });

  if (!item) {
    return {
      success: false,
      error: `Item '${itemName}' not found in your inventory (or it's equipped).`,
    };
  }

  // Use the nearby stall's region for the order
  const region = await prisma.region.findUnique({
    where: { id: nearbyStall.regionId },
  });

  if (!region) {
    return {
      success: false,
      error: 'No trading region found for this market stall.',
    };
  }

  // For world orders, check slot availability
  let worldSlotIndex: number | undefined;
  if (scope === 'WORLD') {
    // Count current world orders
    const worldOrders = await prisma.marketOrder.count({
      where: {
        sellerId: context.characterId,
        orderScope: 'WORLD',
        status: { in: ['ACTIVE', 'PENDING_DELIVERY'] },
      },
    });

    // Get unlocked slots
    const unlockedSlots = await prisma.worldMarketSlot.findMany({
      where: { characterId: context.characterId },
    });

    const totalSlots = Math.max(3, unlockedSlots.length); // 3 free slots minimum
    if (worldOrders >= totalSlots) {
      return {
        success: false,
        error: `You have used all ${totalSlots} world market slots. Cancel an order or unlock more slots.`,
      };
    }

    // Find first available slot
    const usedSlots = new Set(
      (
        await prisma.marketOrder.findMany({
          where: {
            sellerId: context.characterId,
            orderScope: 'WORLD',
            status: { in: ['ACTIVE', 'PENDING_DELIVERY'] },
          },
          select: { worldSlotIndex: true },
        })
      ).map((o) => o.worldSlotIndex)
    );

    for (let i = 0; i < totalSlots; i++) {
      if (!usedSlots.has(i)) {
        worldSlotIndex = i;
        break;
      }
    }
  }

  // Calculate listing fee (2%)
  const listingFee = Math.floor(price * 0.02);

  // Check if seller has enough gold for listing fee
  const balance = await WalletService.getBalance(context.characterId);
  if (balance < listingFee) {
    return {
      success: false,
      error: `Insufficient funds for listing fee. You need ${listingFee} gold (2% of listing price).`,
    };
  }

  // Create the order via event (MarketBridge will handle)
  return {
    success: true,
    message: `Listing ${item.template.name} for ${price} gold (${scope.toLowerCase()}, ${listingFee}g fee)...`,
    data: { type: 'market_list', success: true },
    events: [
      {
        type: 'market_order_create',
        data: {
          characterId: context.characterId,
          regionId: region.id,
          itemTemplateId: item.itemTemplateId,
          inventoryItemId: item.id,
          quantity: item.quantity,
          pricePerUnit: price,
          orderType: 'SELL',
          orderScope: scope,
          stallId: nearbyStall.id,
          worldSlotIndex,
        },
      },
    ],
  };
}

/**
 * Handle /market buy - Purchase from a listing
 */
async function handleBuy(context: CommandContext, args: string[]): Promise<CommandResult> {
  const orderId = args[0];
  const quantity = args[1] ? parseInt(args[1], 10) : undefined;

  if (!orderId) {
    return { success: false, error: 'Usage: /market buy <order_id> [quantity]' };
  }

  // Find the order
  const order = await prisma.marketOrder.findUnique({
    where: { id: orderId },
    include: { region: true },
  });

  if (!order) {
    return { success: false, error: 'Order not found.' };
  }

  if (order.status !== 'ACTIVE') {
    return { success: false, error: 'This order is no longer active.' };
  }

  if (order.sellerId === context.characterId) {
    return { success: false, error: 'You cannot buy your own listing.' };
  }

  // Calculate cost
  const availableQuantity = order.quantity - order.filledQuantity;
  const buyQuantity = quantity ? Math.min(quantity, availableQuantity) : availableQuantity;
  const totalCost = order.pricePerUnit * buyQuantity;

  // Check funds
  const balance = await WalletService.getBalance(context.characterId);
  if (balance < totalCost) {
    return {
      success: false,
      error: `Insufficient funds. You need ${totalCost} gold but only have ${balance}.`,
    };
  }

  // Get item name for message
  const template = await prisma.itemTemplate.findUnique({
    where: { id: order.itemTemplateId },
    select: { name: true },
  });

  return {
    success: true,
    message: `Purchasing ${buyQuantity}x ${template?.name ?? 'item'} for ${totalCost} gold...`,
    data: { type: 'market_buy', success: true },
    events: [
      {
        type: 'market_order_fill',
        data: {
          buyerId: context.characterId,
          orderId: order.id,
          quantity: buyQuantity,
        },
      },
    ],
  };
}

/**
 * Handle /market cancel - Cancel your listing
 */
async function handleCancel(context: CommandContext, args: string[]): Promise<CommandResult> {
  const orderId = args[0];

  if (!orderId) {
    return { success: false, error: 'Usage: /market cancel <order_id>' };
  }

  // Find the order
  const order = await prisma.marketOrder.findUnique({
    where: { id: orderId },
  });

  if (!order) {
    return { success: false, error: 'Order not found.' };
  }

  if (order.sellerId !== context.characterId) {
    return { success: false, error: 'This is not your order.' };
  }

  if (order.status !== 'ACTIVE') {
    return { success: false, error: 'This order cannot be cancelled (status: ' + order.status + ').' };
  }

  return {
    success: true,
    message: 'Cancelling order...',
    data: { type: 'market_cancel', success: true },
    events: [
      {
        type: 'market_order_cancel',
        data: {
          characterId: context.characterId,
          orderId: order.id,
        },
      },
    ],
  };
}

/**
 * Handle /market search - Search listings
 */
async function handleSearch(_context: CommandContext, args: string[], nearbyStall: MarketStall): Promise<CommandResult> {
  const searchTerm = args[0];
  const scopeArg = args[1]?.toLowerCase();

  if (!searchTerm) {
    return { success: false, error: 'Usage: /market search <item_name> [regional|world]' };
  }

  // Determine scope and region (use the stall's region)
  const scope = scopeArg === 'world' ? 'WORLD' : scopeArg === 'regional' ? 'REGIONAL' : undefined;

  const region = await prisma.region.findUnique({
    where: { id: nearbyStall.regionId },
  });

  // Build query
  const where: Record<string, unknown> = {
    status: 'ACTIVE',
  };

  // Search for item by name (partial match)
  const matchingTemplates = await prisma.itemTemplate.findMany({
    where: { name: { contains: searchTerm, mode: 'insensitive' } },
    select: { id: true },
    take: 20,
  });

  if (matchingTemplates.length === 0) {
    return {
      success: true,
      message: `No items found matching '${searchTerm}'.`,
      data: { type: 'market_search', results: [] },
    };
  }

  where.itemTemplateId = { in: matchingTemplates.map((t) => t.id) };

  if (scope) {
    where.orderScope = scope;
  }

  if (scope === 'REGIONAL' && region) {
    where.regionId = region.id;
  }

  // Query orders
  const orders = await prisma.marketOrder.findMany({
    where,
    include: {
      region: { select: { name: true } },
    },
    orderBy: { pricePerUnit: 'asc' },
    take: 20,
  });

  if (orders.length === 0) {
    return {
      success: true,
      message: `No listings found for '${searchTerm}'.`,
      data: { type: 'market_search', results: [] },
    };
  }

  // Get item names
  const itemTemplateIds = [...new Set(orders.map((o) => o.itemTemplateId))];
  const templates = await prisma.itemTemplate.findMany({
    where: { id: { in: itemTemplateIds } },
    select: { id: true, name: true },
  });
  const nameMap = new Map(templates.map((t) => [t.id, t.name]));

  // Format results
  const lines = orders.map((o) => {
    const itemName = nameMap.get(o.itemTemplateId) ?? 'Unknown';
    const qty = o.quantity - o.filledQuantity;
    const scopeTag = o.orderScope === 'WORLD' ? '[W]' : '[R]';
    return `  ${scopeTag} ${itemName} x${qty} @ ${o.pricePerUnit}g - ${o.region?.name ?? 'Unknown'} (${o.id.slice(0, 8)})`;
  });

  // Build structured results for UI clients
  const results = orders.map((o) => ({
    orderId: o.id,
    itemName: nameMap.get(o.itemTemplateId) ?? 'Unknown',
    quantity: o.quantity - o.filledQuantity,
    pricePerUnit: o.pricePerUnit,
    scope: o.orderScope as 'REGIONAL' | 'WORLD',
    regionName: o.region?.name ?? 'Unknown',
  }));

  return {
    success: true,
    message: `Found ${orders.length} listing(s) for '${searchTerm}':\n${lines.join('\n')}`,
    data: { type: 'market_search', results },
  };
}

/**
 * Handle /market myorders - View your active orders
 */
async function handleMyOrders(context: CommandContext): Promise<CommandResult> {
  const orders = await prisma.marketOrder.findMany({
    where: {
      sellerId: context.characterId,
      status: { in: ['ACTIVE', 'PENDING_DELIVERY'] },
    },
    include: {
      region: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  if (orders.length === 0) {
    return {
      success: true,
      message: 'You have no active market orders.',
      data: { type: 'market_orders', orders: [] },
    };
  }

  // Get item names
  const itemTemplateIds = [...new Set(orders.map((o) => o.itemTemplateId))];
  const templates = await prisma.itemTemplate.findMany({
    where: { id: { in: itemTemplateIds } },
    select: { id: true, name: true },
  });
  const nameMap = new Map(templates.map((t) => [t.id, t.name]));

  const lines = orders.map((o) => {
    const itemName = nameMap.get(o.itemTemplateId) ?? 'Unknown';
    const qty = o.quantity - o.filledQuantity;
    const filled = o.filledQuantity > 0 ? ` (${o.filledQuantity} sold)` : '';
    const scopeTag = o.orderScope === 'WORLD' ? '[W]' : '[R]';
    return `  ${scopeTag} ${itemName} x${qty} @ ${o.pricePerUnit}g${filled} - ${o.id.slice(0, 8)}`;
  });

  // Build structured order data for UI clients
  const orderData = orders.map((o) => ({
    orderId: o.id,
    itemName: nameMap.get(o.itemTemplateId) ?? 'Unknown',
    quantity: o.quantity - o.filledQuantity,
    filledQuantity: o.filledQuantity,
    pricePerUnit: o.pricePerUnit,
    scope: o.orderScope as 'REGIONAL' | 'WORLD',
    status: o.status,
  }));

  return {
    success: true,
    message: `Your active orders (${orders.length}):\n${lines.join('\n')}`,
    data: { type: 'market_orders', orders: orderData },
  };
}

/**
 * Handle /market wallet - Check gold balance
 */
async function handleWallet(context: CommandContext): Promise<CommandResult> {
  const balance = await WalletService.getBalance(context.characterId);

  return {
    success: true,
    message: `Your wallet balance: ${balance} gold`,
    data: { type: 'market_wallet', balance },
  };
}

/**
 * Handle /market stall - Show info about the nearby market stall
 */
async function handleStall(stall: MarketStall): Promise<CommandResult> {
  // Get owner name
  const owner = await prisma.character.findUnique({
    where: { id: stall.ownerId },
    select: { name: true },
  });

  // Get region name
  const region = await prisma.region.findUnique({
    where: { id: stall.regionId },
    select: { name: true },
  });

  // Count active orders at this stall
  const activeOrders = await prisma.marketOrder.count({
    where: { stallId: stall.id, status: 'ACTIVE' },
  });

  return {
    success: true,
    message: [
      `Market Stall: ${stall.name}`,
      `  Owner: ${owner?.name ?? 'NPC'}`,
      `  Region: ${region?.name ?? 'Unknown'}`,
      `  Type: ${stall.stallType}`,
      `  Active listings: ${activeOrders}`,
    ].join('\n'),
    data: {
      type: 'market_stall',
      stall: {
        name: stall.name,
        owner: owner?.name ?? 'NPC',
        region: region?.name ?? 'Unknown',
        stallType: stall.stallType,
        activeOrders,
      },
    },
  };
}

/**
 * Parse list command arguments.
 *
 * The CommandParser tokenizer already strips quotes, so multi-word item names
 * arrive as a single token (e.g., `"Iron Sword"` → token `Iron Sword`).
 * We work directly on the token array instead of re-joining + regex.
 *
 * Expected patterns (all tokens, quotes already stripped):
 *   <itemName> <price>
 *   <itemName> <price> <world|regional>
 */
function parseListArgs(
  args: string[]
): { itemName: string; price: number; scope: 'REGIONAL' | 'WORLD' } | null {
  if (args.length < 2) return null;

  // Check if the last token is a scope qualifier
  let scope: 'REGIONAL' | 'WORLD' = 'REGIONAL';
  let priceIdx = args.length - 1;
  const lastArg = args[args.length - 1]!.toLowerCase();
  if (lastArg === 'world' || lastArg === 'regional') {
    scope = lastArg === 'world' ? 'WORLD' : 'REGIONAL';
    priceIdx = args.length - 2;
  }

  if (priceIdx < 1) return null;

  const price = parseInt(args[priceIdx]!, 10);
  if (isNaN(price) || price < 1) return null;

  // Everything before the price token is the item name
  const itemName = args.slice(0, priceIdx).join(' ');
  if (!itemName) return null;

  return { itemName, price, scope };
}
