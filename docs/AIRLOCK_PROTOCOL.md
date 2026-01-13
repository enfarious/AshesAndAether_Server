# Airlock Protocol

This document describes the Socket.IO message payloads used by the airlock
client to authenticate and inhabit NPCs.

## Auth (airlock)

Request:
```
{
  "type": "auth",
  "payload": {
    "method": "airlock",
    "airlockKey": "AIRLOCK_SHARED_SECRET",
    "airlockId": "airlock-main",
    "clientVersion": "0.1.0",
    "capabilities": {
      "llm": true,
      "multiSession": true
    }
  }
}
```

Response:
```
{
  "type": "auth_success",
  "payload": {
    "accountId": "",
    "token": "airlock-session",
    "characters": [],
    "canCreateCharacter": false,
    "maxCharacters": 0,
    "airlockSessionId": "airlock-session-uuid",
    "expiresAt": 1769999999999,
    "canInhabit": true,
    "maxConcurrentInhabits": 5
  }
}
```

## Inhabit

Request:
```
{
  "type": "inhabit_request",
  "payload": {
    "airlockSessionId": "airlock-session-uuid",
    "npcId": "npc-uuid-optional",
    "npcTag": "merchant",
    "intent": "companion",
    "ttlMs": 300000
  }
}
```

Granted:
```
{
  "type": "inhabit_granted",
  "payload": {
    "inhabitId": "inhabit-uuid",
    "npcId": "npc-uuid",
    "displayName": "Old Merchant",
    "zoneId": "USA_NY_Stephentown",
    "expiresAt": 1769999999999
  }
}
```

Denied:
```
{
  "type": "inhabit_denied",
  "payload": {
    "reason": "npc_unavailable"
  }
}
```

## Inhabit Chat

```
{
  "type": "inhabit_chat",
  "payload": {
    "inhabitId": "inhabit-uuid",
    "channel": "say",
    "message": "Welcome, traveler.",
    "timestamp": 1769999999999
  }
}
```

## Inhabit Ping / Release

Ping:
```
{
  "type": "inhabit_ping",
  "payload": {
    "inhabitId": "inhabit-uuid"
  }
}
```

Release:
```
{
  "type": "inhabit_release",
  "payload": {
    "inhabitId": "inhabit-uuid",
    "reason": "session_end"
  }
}
```

Revoked:
```
{
  "type": "inhabit_revoked",
  "payload": {
    "inhabitId": "inhabit-uuid",
    "reason": "timeout"
  }
}
```

## Proximity Roster Delta (entity fields)

```
{
  "id": "entity-id",
  "name": "Old Merchant",
  "type": "companion",
  "isMachine": true,
  "bearing": 90,
  "elevation": -45,
  "range": 2.83
}
```
