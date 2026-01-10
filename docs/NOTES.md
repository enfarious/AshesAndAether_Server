# Development Notes - World of Darkness Server

## Project Context
Building an MMO server for a World of Darkness inspired game with:
- Active Time Battle (ATB) combat system (cooldown-based, real-time)
- LLM-powered AI companions with memory and personality
- Wildlife ecosystem simulation (hunger, thirst, aging, reproduction)
- Support for multiple client types (text, 2D, 3D, VR)
- Original supernatural powers system

## Technical Decisions

### Combat System Evolution
- **Original Plan**: Turn-based/phase-based tactical combat
- **Current Design**: Active Time Battle (ATB) with cooldowns
  - No turns or pauses
  - Emphasis on timing and coordination
  - Combo system for synergistic abilities
  - Position and timing critical

### License Note
- AGPL-3.0 is the correct license (per README)
- package.json shows MIT - needs correction

## Implementation Strategy
- Start with modular monolith architecture
- Design for easy extraction to microservices later
- Server-authoritative - all validation server-side
- Thin clients for all platforms

## Key Design Patterns
- Entity Component System (ECS) for game objects
- Repository pattern for database access
- Message routing for client-server communication
- Behavior trees for scripted AI
- LLM integration for advanced AI companions

## Performance Targets
- Combat: 10-20 TPS (ticks per second)
- Movement: 5-10 TPS
- Wildlife: 1-2 TPS
- Environment: 0.1-1 TPS

## Next Session Prep
When returning to this project:
1. Read TODO.md to see current tasks
2. Read CHANGELOG.md to see what was done last session
3. Check git status and recent commits
4. Review this NOTES.md for important context

## Questions to Resolve
- [ ] What database migrations strategy? (timestamp vs sequential numbering)
- [ ] Redis clustering strategy for scalability?
- [ ] Which navmesh library to use?
- [ ] LLM cost management strategy for companion AI?
- [ ] Rate limiting specifics for different message types?
