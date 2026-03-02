import { prisma } from '../DatabaseService';
import { WalletService } from './WalletService';
import { logger } from '@/utils/logger';
import type { ItemInfo } from '@/network/protocol/types';

export interface RolledItem {
  templateId:  string;
  name:        string;
  description: string;
  itemType:    string;
  iconUrl:     string | null;
  quantity:    number;
}

export class LootService {
  /**
   * Roll items from a loot table. Pure RNG — no DB writes.
   */
  static async rollLoot(lootTableId: string): Promise<RolledItem[]> {
    const table = await prisma.lootTable.findUnique({
      where: { id: lootTableId },
      include: { entries: { include: { itemTemplate: true } } },
    });

    if (!table) {
      logger.warn({ lootTableId }, '[LootService] Loot table not found');
      return [];
    }

    const results: RolledItem[] = [];
    for (const entry of table.entries) {
      if (Math.random() < entry.chance) {
        const qty = entry.minQuantity === entry.maxQuantity
          ? entry.minQuantity
          : entry.minQuantity + Math.floor(Math.random() * (entry.maxQuantity - entry.minQuantity + 1));
        results.push({
          templateId:  entry.itemTemplate.id,
          name:        entry.itemTemplate.name,
          description: entry.itemTemplate.description ?? '',
          itemType:    entry.itemTemplate.itemType,
          iconUrl:     entry.itemTemplate.iconUrl,
          quantity:    qty,
        });
      }
    }

    return results;
  }

  /**
   * Create an InventoryItem record from a rolled item and return the full ItemInfo.
   */
  static async awardItemToCharacter(
    characterId: string,
    item: RolledItem,
  ): Promise<ItemInfo> {
    const inv = await prisma.inventoryItem.create({
      data: {
        characterId,
        itemTemplateId: item.templateId,
        quantity:       item.quantity,
        equipped:       false,
      },
      include: { template: true },
    });

    return {
      id:          inv.id,
      templateId:  inv.itemTemplateId,
      name:        inv.template.name,
      description: inv.template.description ?? '',
      itemType:    inv.template.itemType,
      quantity:    inv.quantity,
      durability:  inv.durability ?? undefined,
      properties:  inv.template.properties as Record<string, unknown>,
      iconUrl:     inv.template.iconUrl ?? undefined,
      equipped:    false,
    };
  }

  /**
   * Award gold to a character's wallet.
   */
  static async awardGold(characterId: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    await WalletService.addGold(characterId, amount, 'mob_loot');
  }
}
