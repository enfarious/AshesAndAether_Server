# Content Safety & Age-Appropriate Design

## Philosophy

Content control through **physical boundaries and context**, not just filters. Zones have content ratings that act as "doors" - clear transitions that both players and LLMs understand.

## Lessons Learned from MOO Implementation

**What Works:**
- Zone-level content ratings with clear boundaries
- LLM system prompts that include zone context and ratings
- Physical "doors" (zone transitions) as natural age gates
- Adult content restricted to specific, clearly-marked locations
- Default to safe content everywhere else

**What Doesn't Work:**
- Relying on LLMs to "ask age first" - they won't
- Filtering after the fact - prevention is better
- Vague content guidelines - be explicit in context

## Content Rating System

Based on ESRB game ratings. **Minimum rating is Teen (T)** - combat is a core gameplay element.

### Rating Levels

**Teen (T) - 13+** [BASELINE]
- Fantasy violence and combat
- Mild blood
- Mild profanity (damn, hell, ass)
- Suggestive themes
- References to alcohol/tobacco
- Examples: Most public areas, wilderness, dungeons, town squares, shops

**Mature (M) - 17+**
- Intense violence and combat
- Blood and gore
- Strong profanity
- Strong sexual themes (fade-to-black)
- Alcohol and drug use depicted
- Intense horror themes
- Examples: Dark city districts, war zones, dangerous wilderness, taverns, underground areas

**Adults Only (AO) - 18+** [AGE-GATED]
- Graphic violence and gore
- Explicit sexual content (with consent mechanics)
- Intense drug use
- Extreme horror
- Examples: Brothels, blood dens, torture chambers, private residences (player-owned), adult establishments

### Zone Configuration

```typescript
type ContentRating = 'T' | 'M' | 'AO';  // Teen, Mature, Adults Only

interface ZoneContentConfig {
  contentRating: ContentRating;

  // Physical barriers
  requiresAgeVerification: boolean;  // Must verify age to enter
  hasEntryWarning: boolean;          // Warning on zone entry
  entryWarningText?: string;         // Custom warning message

  // Behavior allowances
  allowedBehaviors: {
    violence: 'none' | 'cartoon' | 'mild' | 'realistic' | 'graphic';
    profanity: 'none' | 'mild' | 'moderate' | 'strong';
    romance: 'none' | 'themes' | 'fade-to-black' | 'explicit';
    substances: 'none' | 'references' | 'depicted';
    horror: 'none' | 'mild' | 'moderate' | 'intense';
  };

  // LLM specific
  llmSystemPromptAdditions: string;  // Added to all LLM prompts in this zone
  restrictedTopics: string[];        // Topics LLMs should avoid
}
```

### Example Zone Configs

**The Crossroads (Teen)**
```typescript
{
  contentRating: 'T',
  requiresAgeVerification: false,
  hasEntryWarning: false,
  allowedBehaviors: {
    violence: 'cartoon',  // Combat is okay but not graphic
    profanity: 'mild',
    romance: 'themes',
    substances: 'references',
    horror: 'mild'
  },
  llmSystemPromptAdditions: `
    This is a T-rated public area. Combat and adventure are normal.
    Keep profanity mild (damn, hell). No graphic violence or explicit themes.
    Focus on adventure, exploration, and social interaction.
  `,
  restrictedTopics: ['graphic_violence', 'explicit_content', 'strong_profanity']
}
```

**The Serpent's Den (Adults Only - Age Gated)**
```typescript
{
  contentRating: 'AO',
  requiresAgeVerification: true,
  hasEntryWarning: true,
  entryWarningText: "Warning: Adult content area. 18+ only. Explicit themes present.",
  allowedBehaviors: {
    violence: 'realistic',
    profanity: 'strong',
    romance: 'explicit',
    substances: 'depicted',
    horror: 'moderate'
  },
  llmSystemPromptAdditions: `
    This is an 18+ adult establishment. Mature themes are allowed.
    All interactions must still follow consent rules - always confirm
    player comfort before explicit content. Respect boundaries.
  `,
  restrictedTopics: [] // Adult zone, but still enforce consent
}
```

## Age Verification Flow

### Account Creation
```typescript
interface Account {
  id: string;
  email: string;

  // Age verification
  birthdate?: Date;              // Optional but recommended
  ageVerified: boolean;          // Has age been verified?
  ageVerificationMethod?: string; // 'self-reported', 'id-verified', 'parent-approved'

  // Content access (minimum is T for all players)
  contentAccessLevel: 'T' | 'M' | 'AO';  // Defaults to 'T'
  parentalControls?: {
    enabled: boolean;
    maxContentRating: 'T' | 'M';  // Can't restrict below T, can't allow AO for minors
    restrictedZones: string[];
  };
}
```

### Zone Entry Check
```typescript
function canEnterZone(account: Account, zone: Zone): {
  allowed: boolean;
  reason?: string;
  requiresConfirmation?: boolean;
  confirmationMessage?: string;
} {
  // Check content rating access
  const ratingOrder = ['T', 'M', 'AO'];
  const accountLevel = ratingOrder.indexOf(account.contentAccessLevel);
  const zoneLevel = ratingOrder.indexOf(zone.contentRating);

  if (zoneLevel > accountLevel) {
    const ratingNames = { T: 'Teen (13+)', M: 'Mature (17+)', AO: 'Adults Only (18+)' };
    return {
      allowed: false,
      reason: `This area requires ${ratingNames[zone.contentRating]}. Your account access is ${ratingNames[account.contentAccessLevel]}.`
    };
  }

  // Check parental controls
  if (account.parentalControls?.enabled) {
    const maxLevel = ratingOrder.indexOf(account.parentalControls.maxContentRating);
    if (zoneLevel > maxLevel) {
      return {
        allowed: false,
        reason: 'This area is restricted by parental controls.'
      };
    }

    if (account.parentalControls.restrictedZones.includes(zone.id)) {
      return {
        allowed: false,
        reason: 'This area is restricted by parental controls.'
      };
    }
  }

  // Age-gated zones require explicit confirmation
  if (zone.requiresAgeVerification && !account.ageVerified) {
    return {
      allowed: false,
      reason: 'This area requires age verification. Please verify your age in account settings.'
    };
  }

  // Entry warning zones need confirmation
  if (zone.hasEntryWarning) {
    return {
      allowed: true,
      requiresConfirmation: true,
      confirmationMessage: zone.entryWarningText || 'This area contains mature content.'
    };
  }

  return { allowed: true };
}
```

## LLM Integration

### System Prompt Structure
Every LLM (NPC, companion, etc.) gets a safety-first system prompt:

```typescript
function buildLLMSystemPrompt(character: Character, zone: Zone, player: Account): string {
  const basePrompt = `
You are ${character.name}, ${character.description}.

CRITICAL CONTENT SAFETY RULES:
- Current zone: ${zone.name} (Rating: ${zone.contentRating})
- Player content access: ${player.contentAccessLevel}
- Zone allowed behaviors: ${JSON.stringify(zone.allowedBehaviors)}

${zone.llmSystemPromptAdditions}

RESTRICTED TOPICS IN THIS AREA:
${zone.restrictedTopics.map(t => `- ${t}`).join('\n')}

If unsure whether content is appropriate, err on the side of caution.
Always respect player boundaries and comfort levels.
`;

  return basePrompt;
}
```

### Testing LLM Behavior
When testing LLM integration:
1. Test in G-rated zones first - should be completely safe
2. Test boundary cases - what happens at zone transitions?
3. Test with different player age levels
4. Monitor logs for inappropriate content attempts
5. Refine system prompts based on actual behavior

## Default to Teen

**Golden Rule**: When in doubt, assume Teen (T) rating.

- New zones default to T until explicitly configured
- All accounts default to T access (minimum for gameplay)
- Accounts must explicitly verify age for M and AO access
- LLMs default to T-appropriate behavior if context is unclear
- Server should log attempts to generate inappropriate content

## Audit & Compliance

### Logging
```typescript
interface ContentSafetyLog {
  timestamp: number;
  eventType: 'zone_entry_denied' | 'content_filtered' | 'llm_safety_trigger';
  accountId: string;
  zoneId: string;
  contentRating: string;
  details: string;
}
```

### Regular Reviews
- Review logs weekly for safety issues
- Update zone ratings based on player reports
- Refine LLM prompts based on logged violations
- Monitor for patterns of inappropriate behavior

## Player Controls

### User Settings
Players should be able to:
- Set personal content preferences (more restrictive than account level)
- Block specific players or NPCs
- Report inappropriate content
- Toggle mature content warnings
- Set up parental controls for child accounts

### Consent Mechanics
For any mature/adult content:
1. Both parties must be in an A-rated zone
2. Both parties must explicitly consent
3. Either party can revoke consent at any time
4. System logs all consent interactions

## Implementation Priority

**Phase 1 (Foundation):**
- [ ] Add contentRating to Zone schema
- [ ] Add contentAccessLevel to Account schema
- [ ] Implement zone entry checks
- [ ] Set all existing zones to appropriate ratings

**Phase 2 (LLM Safety):**
- [ ] Add content config to LLM system prompts
- [ ] Implement zone-specific behavior rules
- [ ] Test LLM behavior in different zones
- [ ] Add logging for safety events

**Phase 3 (Age Verification):**
- [ ] Implement age verification on signup
- [ ] Add parental control features
- [ ] Create entry warnings for mature zones
- [ ] Implement consent mechanics

**Phase 4 (Monitoring):**
- [ ] Build admin dashboard for safety logs
- [ ] Implement automated content flagging
- [ ] Create player report system
- [ ] Set up regular safety audits

## Resources

- ESRB Rating Guidelines: https://www.esrb.org/ratings-guide/
- COPPA Compliance: https://www.ftc.gov/legal-library/browse/rules/childrens-online-privacy-protection-rule-coppa
- Trust & Safety Best Practices: Industry standards for user-generated content platforms

---

**Remember**: Physical boundaries + clear context = safe, intuitive content control that works for humans and LLMs alike.
