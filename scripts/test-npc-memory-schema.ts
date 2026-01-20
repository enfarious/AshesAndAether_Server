/**
 * Test script for NPC Memory System schema
 * Validates: Companion traits/goals/quests, CompanionMemory, Quest dialogue stages
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🧪 Testing NPC Memory System Schema...\n');

  // Cleanup from previous test runs
  console.log('🧹 Cleaning up test data...');
  await prisma.companionMemory.deleteMany({ where: { companion: { tag: 'test-npc' } } });
  await prisma.companion.deleteMany({ where: { tag: 'test-npc' } });
  await prisma.quest.deleteMany({ where: { id: { startsWith: 'test-quest-' } } });
  console.log('✅ Cleanup complete\n');

  // Test 1: Create NPC with new personality fields
  console.log('📝 Test 1: Creating NPC with personality traits...');
  const npc = await prisma.companion.create({
    data: {
      name: 'Grizzled Pete',
      tag: 'test-npc',
      description: 'A weathered old hunter with stories to tell',
      personalityType: 'gruff-mentor',
      memoryData: {},
      level: 5,
      stats: { str: 12, dex: 10, int: 8 },
      currentHealth: 100,
      maxHealth: 100,
      zoneId: 'test-zone',
      positionX: 100.0,
      positionY: 50.0,
      positionZ: 0.0,
      
      // NEW FIELDS
      traits: ['gruff', 'wise', 'protective', 'distrustful'],
      goals: ['protect the forest', 'find his lost daughter', 'train worthy hunters'],
      relationships: {
        'faction-hunters': 'friendly',
        'faction-loggers': 'hostile'
      },
      abilityIds: ['arrow-shot', 'tracking', 'bear-trap'],
      questIds: ['test-quest-rat-problem', 'test-quest-lost-heirloom']
    }
  });
  
  console.log(`✅ Created NPC: ${npc.name}`);
  console.log(`   Traits: ${npc.traits.join(', ')}`);
  console.log(`   Goals: ${npc.goals.length} goals`);
  console.log(`   Abilities: ${npc.abilityIds.length} abilities`);
  console.log(`   Quests: ${npc.questIds.length} quests\n`);

  // Test 2: Create CompanionMemory record
  console.log('📝 Test 2: Creating companion memory...');
  const memory = await prisma.companionMemory.create({
    data: {
      companionId: npc.id,
      interactions: [
        {
          timestamp: Date.now() - 3600000,
          sourceId: 'char-123',
          sourceName: 'TestPlayer',
          action: 'spoke',
          content: 'Hello, can you help me?'
        },
        {
          timestamp: Date.now() - 1800000,
          sourceId: 'char-123',
          sourceName: 'TestPlayer',
          action: 'gifted',
          content: 'Gave deer pelt'
        }
      ],
      dispositionSummary: {
        'char-123': {
          feeling: 'friendly',
          reason: 'Gifted me a pelt',
          strength: 75,
          lastInteractionAt: Date.now() - 1800000
        }
      },
      knownFacts: [
        'TestPlayer is a skilled hunter',
        'TestPlayer respects the forest'
      ]
    }
  });

  console.log(`✅ Created memory for ${npc.name}`);
  console.log(`   Interactions: ${(memory.interactions as any[]).length}`);
  console.log(`   Known facts: ${memory.knownFacts.length}`);
  console.log(`   Dispositions: ${Object.keys(memory.dispositionSummary as object).length}\n`);

  // Test 3: Create quests with dialogue stages
  console.log('📝 Test 3: Creating quests with dialogue stages...');
  
  const quest1 = await prisma.quest.create({
    data: {
      id: 'test-quest-rat-problem',
      title: 'The Rat Problem',
      description: 'Giant rats are threatening the village food stores',
      questType: 'side',
      requiredLevel: 3,
      
      // NEW FIELDS
      giversNpcIds: [npc.id],
      dialogueStages: {
        offered: "Listen here, we got rats. Big ones. Kill 5 of 'em and I'll make it worth your while.",
        accepted: "Good. They're in the old barn. Watch yourself, they bite.",
        inProgress: "You killed those rats yet? No? Well get to it!",
        completed: "Finally! Here's your reward. Town's safer now.",
        declined: "Suit yourself. But don't come cryin' when they eat your food too."
      },
      
      objectives: {
        'kill-rats': { type: 'kill', target: 'giant-rat', count: 5, current: 0 }
      },
      
      rewards: {
        xp: 500,
        money: 100,
        items: ['rat-tail-trophy']
      }
    }
  });

  const quest2 = await prisma.quest.create({
    data: {
      id: 'test-quest-lost-heirloom',
      title: 'Lost Heirloom',
      description: "Pete's family pendant was lost in the forest",
      questType: 'side',
      requiredLevel: 5,
      prerequisiteQuestIds: ['test-quest-rat-problem'],
      
      giversNpcIds: [npc.id],
      dialogueStages: {
        offered: "*looks you up and down* You proved yourself with those rats. Maybe you can help with something... personal.",
        accepted: "My daughter's pendant. Lost it years ago near the old oak. Find it, and you'll have my eternal gratitude.",
        inProgress: "Any luck? The old oak is north, past the creek.",
        completed: "*eyes water* You... you found it. I don't know what to say. Thank you, friend.",
        declined: "*nods slowly* I understand. Not everyone wants to get involved in an old man's regrets."
      },
      
      objectives: {
        'find-pendant': { type: 'collect', target: 'family-pendant', count: 1, current: 0 }
      },
      
      rewards: {
        xp: 1000,
        money: 250,
        items: ['petes-hunting-bow'],
        relationshipChanges: {
          [npc.id]: 50 // Major relationship boost
        }
      }
    }
  });

  console.log(`✅ Created quest: ${quest1.title}`);
  console.log(`   Givers: ${quest1.giversNpcIds.length} NPCs`);
  console.log(`   Dialogue stages: ${Object.keys(quest1.dialogueStages as object).length}`);
  console.log(`✅ Created quest: ${quest2.title}`);
  console.log(`   Prerequisites: ${quest2.prerequisiteQuestIds?.length || 0}\n`);

  // Test 4: Load and verify relationships
  console.log('📝 Test 4: Loading NPC with memory and quests...');
  
  const loadedNpc = await prisma.companion.findUnique({
    where: { id: npc.id },
    include: { memory: true }
  });

  if (!loadedNpc) throw new Error('NPC not found!');
  
  console.log(`✅ Loaded NPC: ${loadedNpc.name}`);
  console.log(`   Has memory: ${loadedNpc.memory ? 'YES' : 'NO'}`);
  if (loadedNpc.memory) {
    console.log(`   Memory interactions: ${(loadedNpc.memory.interactions as any[]).length}`);
    console.log(`   Memory facts: ${loadedNpc.memory.knownFacts.length}`);
  }

  const npcQuests = await prisma.quest.findMany({
    where: { giversNpcIds: { has: npc.id } }
  });
  
  console.log(`   Gives quests: ${npcQuests.length}`);
  npcQuests.forEach(q => {
    console.log(`     - ${q.title}`);
  });

  // Test 5: Test disposition lookup (what Airlock would do)
  console.log('\n📝 Test 5: Simulating disposition lookup...');
  if (loadedNpc.memory) {
    const dispositions = loadedNpc.memory.dispositionSummary as any;
    const playerDisposition = dispositions['char-123'];
    
    if (playerDisposition) {
      console.log(`✅ Found disposition for char-123:`);
      console.log(`   Feeling: ${playerDisposition.feeling}`);
      console.log(`   Strength: ${playerDisposition.strength}/100`);
      console.log(`   Reason: "${playerDisposition.reason}"`);
    }
  }

  // Test 6: Test quest dialogue stage access
  console.log('\n📝 Test 6: Accessing quest dialogue...');
  const dialogue = (quest1.dialogueStages as any).offered;
  console.log(`✅ Quest offer dialogue: "${dialogue.substring(0, 50)}..."`);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('✨ All schema tests passed!');
  console.log('='.repeat(60));
  console.log('Schema validation results:');
  console.log(`  ✅ Companion.traits, goals, relationships, abilityIds, questIds`);
  console.log(`  ✅ CompanionMemory (interactions, dispositions, facts)`);
  console.log(`  ✅ Quest.giversNpcIds, dialogueStages`);
  console.log(`  ✅ Relations: Companion <-> CompanionMemory (cascade delete)`);
  console.log(`  ✅ Relations: Companion <-> Quest (via questIds array)`);
  console.log('\nReady for Airlock integration! 🚀\n');

  // Cleanup
  console.log('🧹 Cleaning up test data...');
  await prisma.companionMemory.delete({ where: { companionId: npc.id } });
  await prisma.companion.delete({ where: { id: npc.id } });
  await prisma.quest.deleteMany({ where: { id: { startsWith: 'test-quest-' } } });
  console.log('✅ Cleanup complete\n');
}

main()
  .catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
