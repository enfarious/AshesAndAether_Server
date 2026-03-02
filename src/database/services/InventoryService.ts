import { prisma } from '../DatabaseService';
import { logger } from '@/utils/logger';
import type { EquipSlot, ItemInfo, InventoryUpdatePayload } from '@/network/protocol/types';

/**
 * InventoryService — all database operations for inventory and equipment.
 *
 * Each method loads items with their template data and returns typed payloads
 * suitable for the client protocol.
 */
export class InventoryService {

  /**
   * Load all inventory items for a character and format them as ItemInfo records.
   */
  static async getItems(characterId: string): Promise<ItemInfo[]> {
    const rows = await prisma.inventoryItem.findMany({
      where:   { characterId },
      include: { template: true },
      orderBy: [{ template: { itemType: 'asc' } }, { template: { name: 'asc' } }],
    });

    return rows.map(row => ({
      id:          row.id,
      templateId:  row.itemTemplateId,
      name:        row.template.name,
      description: row.template.description ?? '',
      itemType:    row.template.itemType,
      quantity:    row.quantity,
      durability:  row.durability ?? undefined,
      properties:  (row.template.properties as Record<string, unknown>) ?? undefined,
      iconUrl:     row.template.iconUrl ?? undefined,
      equipped:    row.equipped,
      equipSlot:   (row.equipSlot as EquipSlot | null) ?? undefined,
    }));
  }

  /**
   * Build the full InventoryUpdatePayload for a character.
   * @param activeWeaponSet  Current in-memory weapon set (1 or 2) from the session.
   */
  static async buildPayload(
    characterId:   string,
    activeWeaponSet: 1 | 2 = 1,
  ): Promise<InventoryUpdatePayload> {
    const all = await this.getItems(characterId);

    const items:     ItemInfo[]                           = [];
    const equipment: Partial<Record<EquipSlot, ItemInfo>> = {};

    for (const item of all) {
      if (item.equipped && item.equipSlot) {
        equipment[item.equipSlot] = item;
      } else {
        items.push(item);
      }
    }

    return { items, equipment, activeWeaponSet, timestamp: Date.now() };
  }

  /**
   * Equip an item from inventory into the specified slot.
   *
   * Rules:
   * - The item must belong to the character and not already be equipped elsewhere
   * - If the slot already has an item, it is automatically unequipped (swapped)
   * - The slot must match the item's allowed equip slots (enforced by itemType)
   *
   * Returns the new payload or throws if the operation is invalid.
   */
  static async equipItem(
    characterId:   string,
    itemId:        string,
    slot:          EquipSlot,
    activeWeaponSet: 1 | 2,
  ): Promise<InventoryUpdatePayload> {
    // Load the item
    const item = await prisma.inventoryItem.findFirst({
      where:   { id: itemId, characterId },
      include: { template: true },
    });
    if (!item) throw new Error('Item not found');
    if (item.equipped) throw new Error('Item is already equipped');

    // Validate the slot is appropriate for this item type
    const allowed = allowedSlotsForType(item.template.itemType);
    if (!allowed.includes(slot)) {
      throw new Error(`Cannot equip ${item.template.itemType} in slot "${slot}"`);
    }

    // If there's something in the target slot, unequip it first
    await prisma.inventoryItem.updateMany({
      where:  { characterId, equipped: true, equipSlot: slot },
      data:   { equipped: false, equipSlot: null },
    });

    // Equip the new item
    await prisma.inventoryItem.update({
      where: { id: itemId },
      data:  { equipped: true, equipSlot: slot },
    });

    return this.buildPayload(characterId, activeWeaponSet);
  }

  /**
   * Unequip the item in the given slot, returning it to inventory.
   */
  static async unequipItem(
    characterId:   string,
    slot:          EquipSlot,
    activeWeaponSet: 1 | 2,
  ): Promise<InventoryUpdatePayload> {
    await prisma.inventoryItem.updateMany({
      where: { characterId, equipped: true, equipSlot: slot },
      data:  { equipped: false, equipSlot: null },
    });

    return this.buildPayload(characterId, activeWeaponSet);
  }

  /**
   * Swap between weapon set 1 (mainhand/offhand) and weapon set 2 (mainhand2/offhand2).
   * Returns the new active set number.
   */
  static swapWeaponSet(current: 1 | 2): 1 | 2 {
    return current === 1 ? 2 : 1;
  }

  /**
   * Award an item to a character by looking up an ItemTemplate via ItemTag name.
   *
   * Harvest items (berries, carrot, mushroom, etc.) reference item templates by their
   * tag slug (the unique name on the ItemTag model). If no template is linked to the tag,
   * the call is a no-op and a warning is logged — this lets harvesting work gracefully even
   * before the item templates are fully seeded.
   *
   * Returns the created ItemInfo, or null if the tag/template could not be resolved.
   */
  static async addItemByTemplateTag(
    characterId: string,
    tag:         string,
    quantity:    number,
  ): Promise<ItemInfo | null> {
    // Resolve the ItemTag → first linked ItemTemplate
    const tagRecord = await prisma.itemTag.findUnique({
      where:   { name: tag },
      include: {
        templates: {
          take:    1,
          include: { itemTemplate: true },
        },
      },
    });

    if (!tagRecord || tagRecord.templates.length === 0) {
      logger.warn({ tag, characterId }, '[InventoryService] No ItemTemplate found for harvest tag — item not awarded');
      return null;
    }

    const template = tagRecord.templates[0]!.itemTemplate;

    const inv = await prisma.inventoryItem.create({
      data: {
        characterId,
        itemTemplateId: template.id,
        quantity,
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
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Which equip slots a given itemType may occupy.
 * Extend as more item types are added.
 */
function allowedSlotsForType(itemType: string): EquipSlot[] {
  switch (itemType.toLowerCase()) {
    case 'weapon':
    case 'sword': case 'axe': case 'staff': case 'wand': case 'bow': case 'dagger':
      return ['mainhand', 'offhand', 'mainhand2', 'offhand2'];
    case 'shield': case 'offhand':
      return ['offhand', 'offhand2'];
    case 'armor': case 'chest': case 'body':
      return ['body'];
    case 'helm': case 'hat': case 'head':
      return ['head'];
    case 'gloves': case 'hands':
      return ['hands'];
    case 'pants': case 'legs':
      return ['legs'];
    case 'boots': case 'feet':
      return ['feet'];
    case 'necklace': case 'amulet':
      return ['necklace'];
    case 'bracelet': case 'wrist':
      return ['bracelet'];
    case 'ring':
      return ['ring1', 'ring2'];
    default:
      // Generic fallback: allow any slot (admin/debug items)
      return ['mainhand', 'offhand', 'head', 'body', 'hands', 'legs', 'feet',
              'necklace', 'bracelet', 'ring1', 'ring2', 'mainhand2', 'offhand2'];
  }
}
