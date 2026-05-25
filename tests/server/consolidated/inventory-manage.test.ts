/**
 * Tests for consolidated inventory_manage tool
 * Validates all 8 actions: give, remove, transfer, use, equip, unequip, get, get_detailed
 */

import { handleInventoryManage, InventoryManageTool } from '../../../src/server/consolidated/inventory-manage.js';
import { handleItemManage } from '../../../src/server/consolidated/item-manage.js';
import { getDb } from '../../../src/storage/index.js';
import { CharacterRepository } from '../../../src/storage/repos/character.repo.js';
import { InventoryRepository } from '../../../src/storage/repos/inventory.repo.js';
import { randomUUID } from 'crypto';

// Force test mode
process.env.NODE_ENV = 'test';

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
    const text = result.content[0].text;
    // Match HTML comment format: <!-- INVENTORY_MANAGE_JSON ... INVENTORY_MANAGE_JSON -->
    const jsonMatch = text.match(/<!-- INVENTORY_MANAGE_JSON\n([\s\S]*?)\nINVENTORY_MANAGE_JSON -->/);
    return jsonMatch ? JSON.parse(jsonMatch[1]) : null;
}

function parseItemResult(result: { content: Array<{ type: string; text: string }> }) {
    const text = result.content[0].text;
    const jsonMatch = text.match(/<!-- ITEM_MANAGE_JSON\n([\s\S]*?)\nITEM_MANAGE_JSON -->/);
    return jsonMatch ? JSON.parse(jsonMatch[1]) : null;
}

describe('inventory_manage consolidated tool', () => {
    const ctx = { sessionId: 'test-session' };
    let testCharId: string;
    let testItemId: string;

    beforeEach(async () => {
        // Reset test database - getDb runs migrations which creates tables
        const db = getDb(':memory:');

        // Clear data (correct table names)
        db.exec('DELETE FROM inventory_items');
        db.exec('DELETE FROM items');
        db.exec('DELETE FROM characters');

        // Create a test character
        const charRepo = new CharacterRepository(db);
        testCharId = randomUUID();
        charRepo.create({
            id: testCharId,
            name: 'Test Hero',
            class: 'fighter',
            level: 1,
            race: 'human',
            hp: 10,
            maxHp: 10,
            ac: 10,
            stats: { str: 14, dex: 12, con: 13, int: 10, wis: 11, cha: 10 },
            speed: 30,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });

        // Create a test item
        const itemResult = await handleItemManage({
            action: 'create',
            name: 'Test Sword',
            type: 'weapon',
            weight: 3,
            value: 15
        }, ctx);
        testItemId = parseItemResult(itemResult).item.id;
    });

    describe('Tool Definition', () => {
        it('should have correct tool name', () => {
            expect(InventoryManageTool.name).toBe('inventory_manage');
        });

        it('should list all available actions in description', () => {
            expect(InventoryManageTool.description).toContain('give');
            expect(InventoryManageTool.description).toContain('remove');
            expect(InventoryManageTool.description).toContain('transfer');
            expect(InventoryManageTool.description).toContain('use');
            expect(InventoryManageTool.description).toContain('equip');
            expect(InventoryManageTool.description).toContain('unequip');
            expect(InventoryManageTool.description).toContain('get');
            expect(InventoryManageTool.description).toContain('get_detailed');
        });
    });

    describe('give action', () => {
        it('should add an item to inventory', async () => {
            const result = await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('give');
            expect(data.itemName).toBe('Test Sword');
            expect(data.quantity).toBe(1);
        });

        it('should add multiple items', async () => {
            // Create stackable item
            const potionResult = await handleItemManage({
                action: 'create',
                name: 'Health Potion',
                type: 'consumable',
                weight: 0.5,
                value: 50
            }, ctx);
            const potionId = parseItemResult(potionResult).item.id;

            const result = await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: potionId,
                quantity: 5
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.quantity).toBe(5);
        });

        it('should accept "add" alias', async () => {
            const result = await handleInventoryManage({
                action: 'add',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });

        it('should return error for non-existent item', async () => {
            const result = await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: 'fake-item-id',
                quantity: 1
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBeDefined();
            expect(data.message).toContain('Item not found');
        });
    });

    describe('remove action', () => {
        beforeEach(async () => {
            // Give item first
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 3
            }, ctx);
        });

        it('should remove items from inventory', async () => {
            const result = await handleInventoryManage({
                action: 'remove',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('remove');
        });

        it('should accept "take" alias', async () => {
            const result = await handleInventoryManage({
                action: 'take',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });

        it('should return error if not enough quantity', async () => {
            const result = await handleInventoryManage({
                action: 'remove',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 100
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBeDefined();
        });
    });

    describe('transfer action', () => {
        let secondCharId: string;

        beforeEach(async () => {
            // Create second character
            const db = getDb(':memory:');
            const charRepo = new CharacterRepository(db);
            secondCharId = randomUUID();
            charRepo.create({
                id: secondCharId,
                name: 'Second Hero',
                class: 'rogue',
                level: 1,
                race: 'elf',
                hp: 8,
                maxHp: 8,
                ac: 12,
                stats: { str: 10, dex: 16, con: 10, int: 12, wis: 10, cha: 14 },
                speed: 30,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });

            // Give first character an item
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 2
            }, ctx);
        });

        it('should transfer item between characters', async () => {
            const result = await handleInventoryManage({
                action: 'transfer',
                fromCharacterId: testCharId,
                toCharacterId: secondCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('transfer');
            expect(data.fromCharacterId).toBe(testCharId);
            expect(data.toCharacterId).toBe(secondCharId);
        });

        it('should accept "trade" alias', async () => {
            const result = await handleInventoryManage({
                action: 'trade',
                fromCharacterId: testCharId,
                toCharacterId: secondCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });
    });

    describe('use action', () => {
        let consumableId: string;

        beforeEach(async () => {
            // Create consumable item
            const potionResult = await handleItemManage({
                action: 'create',
                name: 'Healing Potion',
                type: 'consumable',
                weight: 0.5,
                value: 50,
                properties: { effect: 'Restore 2d4+2 HP' }
            }, ctx);
            consumableId = parseItemResult(potionResult).item.id;

            // Give it to character
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: consumableId,
                quantity: 3
            }, ctx);
        });

        it('should use consumable item', async () => {
            const result = await handleInventoryManage({
                action: 'use',
                characterId: testCharId,
                itemId: consumableId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('use');
            expect(data.effect).toBe('Restore 2d4+2 HP');
        });

        it('rolls properties.healing and applies HP to the target (#36)', async () => {
            const db = getDb(':memory:');
            const charRepo = new CharacterRepository(db);
            // Damage the hero to 6/10 — any 2d4+2 (min 4) heals to full, so the
            // clamp makes the result deterministic (hpAfter = 10, healing = 4).
            charRepo.update(testCharId, { hp: 6 } as any);

            const potion = await handleItemManage({
                action: 'create',
                name: 'Potion of Healing',
                type: 'consumable',
                weight: 0.5,
                value: 50,
                properties: { healing: '2d4+2' }
            }, ctx);
            const healingPotionId = parseItemResult(potion).item.id;

            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: healingPotionId,
                quantity: 1
            }, ctx);

            const result = await handleInventoryManage({
                action: 'use',
                characterId: testCharId,
                itemId: healingPotionId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.hpBefore).toBe(6);
            expect(data.hpAfter).toBe(10);
            expect(data.healing).toBe(4);
            expect(String(data.effect)).toMatch(/heal|HP/i);

            // HP change must be persisted
            expect(charRepo.findById(testCharId)?.hp).toBe(10);
        });

        it('rejects an unknown healing target without consuming the item (#36 — CodeRabbit)', async () => {
            const potion = await handleItemManage({
                action: 'create', name: 'Potion of Healing', type: 'consumable', weight: 0.5, value: 50,
                properties: { healing: '2d4+2' }
            }, ctx);
            const potionId = parseItemResult(potion).item.id;
            await handleInventoryManage({
                action: 'give', characterId: testCharId, itemId: potionId, quantity: 1
            }, ctx);

            // Using on a non-existent target must fail...
            const bad = await handleInventoryManage({
                action: 'use', characterId: testCharId, itemId: potionId, targetId: 'does-not-exist'
            }, ctx);
            expect(parseResult(bad).error).toBeDefined();

            // ...and must NOT have consumed the potion — a valid self-use still works.
            const good = await handleInventoryManage({
                action: 'use', characterId: testCharId, itemId: potionId
            }, ctx);
            expect(parseResult(good).success).toBe(true);
        });

        it('rejects a malformed healing expression without consuming the item (#36 — CodeRabbit)', async () => {
            const potion = await handleItemManage({
                action: 'create', name: 'Cursed Vial', type: 'consumable', weight: 0.5, value: 10,
                properties: { healing: 'not-a-dice-expr' }
            }, ctx);
            const potionId = parseItemResult(potion).item.id;
            await handleInventoryManage({
                action: 'give', characterId: testCharId, itemId: potionId, quantity: 2
            }, ctx);

            const invRepo = new InventoryRepository(getDb(':memory:'));
            const qtyBefore = invRepo.getInventory(testCharId).items.find((i: any) => i.itemId === potionId)?.quantity;
            expect(qtyBefore).toBe(2); // guard: repo sees the same in-memory DB the handler writes to

            const result = await handleInventoryManage({
                action: 'use', characterId: testCharId, itemId: potionId
            }, ctx);
            expect(parseResult(result).error).toBeDefined();

            // A malformed expression must be rejected BEFORE the item is consumed.
            const qtyAfter = invRepo.getInventory(testCharId).items.find((i: any) => i.itemId === potionId)?.quantity;
            expect(qtyAfter).toBe(qtyBefore);
        });

        it('a negative healing roll never reduces HP (#36 — CodeRabbit)', async () => {
            const db = getDb(':memory:');
            const charRepo = new CharacterRepository(db);
            charRepo.update(testCharId, { hp: 8 } as any);

            const potion = await handleItemManage({
                action: 'create', name: 'Cursed Draught', type: 'consumable', weight: 0.5, value: 5,
                properties: { healing: '2d4-50' } // valid expression, negative result
            }, ctx);
            const potionId = parseItemResult(potion).item.id;
            await handleInventoryManage({ action: 'give', characterId: testCharId, itemId: potionId, quantity: 1 }, ctx);
            const useResult = await handleInventoryManage({ action: 'use', characterId: testCharId, itemId: potionId }, ctx);
            expect(parseResult(useResult).success).toBe(true); // don't false-pass if `use` errored

            // Healing clamps to 0 — HP must not drop below where it started.
            expect(charRepo.findById(testCharId)?.hp).toBe(8);
        });

        it('should accept "consume" alias', async () => {
            const result = await handleInventoryManage({
                action: 'consume',
                characterId: testCharId,
                itemId: consumableId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });

        it('should return error for non-consumable items', async () => {
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);

            const result = await handleInventoryManage({
                action: 'use',
                characterId: testCharId,
                itemId: testItemId
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBeDefined();
            expect(data.message).toContain('not a consumable');
        });
    });

    describe('equip action', () => {
        beforeEach(async () => {
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);
        });

        it('should equip an item', async () => {
            const result = await handleInventoryManage({
                action: 'equip',
                characterId: testCharId,
                itemId: testItemId,
                slot: 'mainhand'
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('equip');
            expect(data.slot).toBe('mainhand');
        });

        it('should accept "wield" alias', async () => {
            const result = await handleInventoryManage({
                action: 'wield',
                characterId: testCharId,
                itemId: testItemId,
                slot: 'mainhand'
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });

        it('should return error for item not owned', async () => {
            const otherItemResult = await handleItemManage({
                action: 'create',
                name: 'Other Sword',
                type: 'weapon',
                weight: 3,
                value: 20
            }, ctx);
            const otherItemId = parseItemResult(otherItemResult).item.id;

            const result = await handleInventoryManage({
                action: 'equip',
                characterId: testCharId,
                itemId: otherItemId,
                slot: 'mainhand'
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBeDefined();
            expect(data.message).toContain('does not own');
        });

        it('rejects equipping a consumable in a weapon slot (#37)', async () => {
            const potion = await handleItemManage({
                action: 'create', name: 'Potion', type: 'consumable', weight: 0.5, value: 25
            }, ctx);
            const potionId = parseItemResult(potion).item.id;
            await handleInventoryManage({
                action: 'give', characterId: testCharId, itemId: potionId, quantity: 1
            }, ctx);

            const result = await handleInventoryManage({
                action: 'equip', characterId: testCharId, itemId: potionId, slot: 'mainhand'
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBeDefined();
            expect(String(data.message)).toMatch(/consumable|cannot equip|slot/i);
        });

        it('rejects equipping armor in the accessory slot (#37)', async () => {
            const armor = await handleItemManage({
                action: 'create', name: 'Plate Mail', type: 'armor', weight: 65, value: 1500
            }, ctx);
            const armorId = parseItemResult(armor).item.id;
            await handleInventoryManage({
                action: 'give', characterId: testCharId, itemId: armorId, quantity: 1
            }, ctx);

            const result = await handleInventoryManage({
                action: 'equip', characterId: testCharId, itemId: armorId, slot: 'accessory'
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBeDefined();
        });
    });

    describe('unequip action', () => {
        beforeEach(async () => {
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);
            await handleInventoryManage({
                action: 'equip',
                characterId: testCharId,
                itemId: testItemId,
                slot: 'mainhand'
            }, ctx);
        });

        it('should unequip an item', async () => {
            const result = await handleInventoryManage({
                action: 'unequip',
                characterId: testCharId,
                itemId: testItemId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('unequip');
        });

        it('should accept "doff" alias', async () => {
            const result = await handleInventoryManage({
                action: 'doff',
                characterId: testCharId,
                itemId: testItemId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });
    });

    describe('get action', () => {
        beforeEach(async () => {
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 2
            }, ctx);
        });

        it('should get inventory contents', async () => {
            const result = await handleInventoryManage({
                action: 'get',
                characterId: testCharId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('get');
            expect(data.inventory).toBeDefined();
            expect(data.itemCount).toBeGreaterThan(0);
        });

        it('should accept "list" alias', async () => {
            const result = await handleInventoryManage({
                action: 'list',
                characterId: testCharId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });
    });

    describe('get_detailed action', () => {
        beforeEach(async () => {
            await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 2
            }, ctx);
        });

        it('should get detailed inventory with weights', async () => {
            const result = await handleInventoryManage({
                action: 'get_detailed',
                characterId: testCharId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
            expect(data.actionType).toBe('get_detailed');
            expect(data.totalWeight).toBeDefined();
            expect(data.capacity).toBeDefined();
        });

        it('should accept "detailed" alias', async () => {
            const result = await handleInventoryManage({
                action: 'detailed',
                characterId: testCharId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });

        it('should accept "full" alias', async () => {
            const result = await handleInventoryManage({
                action: 'full',
                characterId: testCharId
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });
    });

    describe('fuzzy matching', () => {
        it('should auto-correct close typos', async () => {
            // "givee" (extra e) has similarity 0.8 with "give" - should auto-correct
            const result = await handleInventoryManage({
                action: 'givee',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);

            const data = parseResult(result);
            expect(data.success).toBe(true);
        });

        it('should provide helpful error for unknown action', async () => {
            const result = await handleInventoryManage({
                action: 'xyz',
                characterId: testCharId
            }, ctx);

            const data = parseResult(result);
            expect(data.error).toBe('invalid_action');
            expect(data.message).toContain('Unknown action');
        });
    });

    describe('output formatting', () => {
        it('should include rich text formatting for give', async () => {
            const result = await handleInventoryManage({
                action: 'give',
                characterId: testCharId,
                itemId: testItemId,
                quantity: 1
            }, ctx);

            const text = result.content[0].text;
            expect(text).toContain('➕'); // Add emoji
            expect(text).toContain('Test Sword');
        });

        it('should embed JSON for parsing', async () => {
            const result = await handleInventoryManage({
                action: 'get',
                characterId: testCharId
            }, ctx);

            const text = result.content[0].text;
            expect(text).toContain('<!-- INVENTORY_MANAGE_JSON');
        });
    });
});
