import { prisma } from '@/database';

export class VillageService {
  // ── Village CRUD ──────────────────────────────────────────────────

  /** Get a character's village, including template and structures. */
  static async getVillage(characterId: string) {
    return prisma.playerVillage.findUnique({
      where: { characterId },
      include: { template: true, structures: { include: { catalog: true } } },
    });
  }

  /** Create a village for a character from a template name. Also creates a Zone record for FK compatibility. */
  static async createVillage(characterId: string, templateName: string, villageName?: string) {
    const template = await prisma.plotTemplate.findUnique({ where: { name: templateName } });
    if (!template) throw new Error(`Template '${templateName}' not found`);

    const existing = await prisma.playerVillage.findUnique({ where: { characterId } });
    if (existing) throw new Error('Character already owns a village');

    // Create a Zone record so Character.zoneId FK works when player enters village.
    // Use negative worldX/Y derived from characterId to avoid unique constraint conflicts.
    const zoneId = VillageService.villageZoneId(characterId);
    const coords = VillageService._villageWorldCoords(characterId);

    const existingZone = await prisma.zone.findUnique({ where: { id: zoneId } });
    if (!existingZone) {
      await prisma.zone.create({
        data: {
          id: zoneId,
          name: villageName ?? `${template.name} Village`,
          description: `A player village`,
          worldX: coords.worldX,
          worldY: coords.worldY,
          sizeX: template.sizeX,
          sizeY: template.sizeY,
          sizeZ: template.sizeZ,
          terrainType: template.terrainType,
          weatherEnabled: true,
          timeOfDayEnabled: true,
          corruptionTag: 'WARD_ZONE',
          isWarded: true,
        },
      });
    }

    return prisma.playerVillage.create({
      data: {
        characterId,
        templateId: template.id,
        name: villageName ?? `${template.name} Village`,
      },
      include: { template: true, structures: { include: { catalog: true } } },
    });
  }

  // ── Structure placement ──────────────────────────────────────────

  /** Place a structure. Validates bounds, grid snap, overlap, and per-type limits. */
  static async placeStructure(
    villageId: string,
    catalogId: string,
    posX: number,
    posZ: number,
    rotation: number,
  ) {
    const village = await prisma.playerVillage.findUnique({
      where: { id: villageId },
      include: { template: true, structures: { include: { catalog: true } } },
    });
    if (!village) throw new Error('Village not found');

    const catalog = await prisma.structureCatalog.findUnique({ where: { id: catalogId } });
    if (!catalog) throw new Error('Structure type not found');

    if (village.structures.length >= village.template.maxStructures) {
      throw new Error(`Village is full (max ${village.template.maxStructures} structures)`);
    }

    const sameType = village.structures.filter(s => s.catalogId === catalogId).length;
    if (sameType >= catalog.maxPerVillage) {
      throw new Error(`Maximum ${catalog.maxPerVillage} ${catalog.displayName}(s) allowed`);
    }

    // Grid snap
    const grid = village.template.gridSize;
    const snappedX = Math.round(posX / grid) * grid;
    const snappedZ = Math.round(posZ / grid) * grid;

    // Validate within buildable area
    const t = village.template;
    if (snappedX < t.buildMinX || snappedX > t.buildMaxX ||
        snappedZ < t.buildMinZ || snappedZ > t.buildMaxZ) {
      throw new Error('Position is outside the buildable area');
    }

    // AABB overlap check
    for (const existing of village.structures) {
      const ec = existing.catalog;
      if (_aabbOverlap(
        snappedX, snappedZ, catalog.sizeX, catalog.sizeZ,
        existing.positionX, existing.positionZ, ec.sizeX, ec.sizeZ,
      )) {
        throw new Error(`Overlaps with existing ${ec.displayName}`);
      }
    }

    return prisma.villageStructure.create({
      data: {
        villageId,
        catalogId,
        positionX: snappedX,
        positionZ: snappedZ,
        rotation: _snapRotation(rotation),
      },
      include: { catalog: true },
    });
  }

  /** Remove a structure by ID. */
  static async removeStructure(structureId: string, villageId: string) {
    return prisma.villageStructure.delete({
      where: { id: structureId, villageId },
    });
  }

  /** Get all available templates. */
  static async getTemplates() {
    return prisma.plotTemplate.findMany({ orderBy: { name: 'asc' } });
  }

  /** Get all available structure catalog entries. */
  static async getCatalog() {
    return prisma.structureCatalog.findMany({ orderBy: { name: 'asc' } });
  }

  /** Find catalog entry by name. */
  static async getCatalogByName(name: string) {
    return prisma.structureCatalog.findUnique({ where: { name } });
  }

  // ── Character return point helpers ────────────────────────────────

  /** Save the character's current zone + position as a return point. */
  static async saveReturnPoint(characterId: string, zoneId: string, x: number, y: number, z: number) {
    await prisma.character.update({
      where: { id: characterId },
      data: { returnZoneId: zoneId, returnPositionX: x, returnPositionY: y, returnPositionZ: z },
    });
  }

  /** Clear the return point after the player has returned. */
  static async clearReturnPoint(characterId: string) {
    await prisma.character.update({
      where: { id: characterId },
      data: { returnZoneId: null, returnPositionX: null, returnPositionY: null, returnPositionZ: null },
    });
  }

  /** Update character's zone and position (for zone transfers). */
  static async updateCharacterZone(characterId: string, zoneId: string, x: number, y: number, z: number) {
    await prisma.character.update({
      where: { id: characterId },
      data: { zoneId, positionX: x, positionY: y, positionZ: z, lastSeenAt: new Date() },
    });
  }

  // ── Utility ───────────────────────────────────────────────────────

  /** Extract owner character ID from a village zone ID. */
  static extractOwnerCharacterId(zoneId: string): string | null {
    if (!zoneId.startsWith('village:')) return null;
    return zoneId.slice('village:'.length);
  }

  /** Build the village zone ID for a character. */
  static villageZoneId(characterId: string): string {
    return `village:${characterId}`;
  }

  /** Check if a zone ID is a village instance. */
  static isVillageZone(zoneId: string): boolean {
    return zoneId.startsWith('village:');
  }

  /** Derive unique negative world coordinates from a character ID for the Zone record. */
  private static _villageWorldCoords(characterId: string): { worldX: number; worldY: number } {
    const clean = characterId.replace(/-/g, '');
    const worldX = -(parseInt(clean.substring(0, 8), 16) % 1_000_000 + 1);
    const worldY = -(parseInt(clean.substring(8, 16), 16) % 1_000_000 + 1);
    return { worldX, worldY };
  }
}

function _aabbOverlap(
  ax: number, az: number, aw: number, ah: number,
  bx: number, bz: number, bw: number, bh: number,
): boolean {
  return Math.abs(ax - bx) < (aw + bw) / 2 &&
         Math.abs(az - bz) < (ah + bh) / 2;
}

function _snapRotation(r: number): number {
  const steps = Math.round(r / (Math.PI / 2));
  return ((steps % 4) + 4) % 4 * (Math.PI / 2);
}
