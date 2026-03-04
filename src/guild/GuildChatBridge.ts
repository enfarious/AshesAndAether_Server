/**
 * GuildChatBridge — Redis pub/sub bridge for cross-zone guild chat.
 *
 * Subscribes to guild:{guildId}:chat channels for guilds with online members.
 * Publishes incoming guild chat to all zone servers.
 */

import { MessageType, type MessageBus } from '../messaging/MessageBus';

export interface GuildChatPayload {
  guildId: string;
  guildTag: string;
  senderId: string;
  senderName: string;
  message: string;
  timestamp: number;
}

export type GuildChatDeliveryCallback = (
  guildId: string,
  payload: GuildChatPayload,
) => void;

export class GuildChatBridge {
  private messageBus: MessageBus;
  private subscribedGuilds: Set<string> = new Set();
  private deliveryCallback: GuildChatDeliveryCallback | null = null;

  constructor(messageBus: MessageBus) {
    this.messageBus = messageBus;
  }

  setDeliveryCallback(callback: GuildChatDeliveryCallback): void {
    this.deliveryCallback = callback;
  }

  /**
   * Subscribe to a guild's chat channel. Call when a guild member comes online.
   */
  async subscribeGuild(guildId: string): Promise<void> {
    if (this.subscribedGuilds.has(guildId)) return;

    const channel = `guild:${guildId}:chat`;
    await this.messageBus.subscribe(channel, (message: any) => {
      if (this.deliveryCallback) {
        this.deliveryCallback(guildId, message as GuildChatPayload);
      }
    });

    this.subscribedGuilds.add(guildId);
  }

  /**
   * Unsubscribe from a guild's chat channel. Call when no members of that guild are online.
   */
  async unsubscribeGuild(guildId: string): Promise<void> {
    if (!this.subscribedGuilds.has(guildId)) return;

    const channel = `guild:${guildId}:chat`;
    await this.messageBus.unsubscribe(channel);
    this.subscribedGuilds.delete(guildId);
  }

  /**
   * Publish a chat message to a guild's channel.
   * All zone servers subscribed to this guild will receive it.
   */
  async publishChat(payload: GuildChatPayload): Promise<void> {
    const channel = `guild:${payload.guildId}:chat`;
    await this.messageBus.publish(channel, {
      type: MessageType.GUILD_CHAT,
      payload,
      timestamp: Date.now(),
    });
  }

  /**
   * Check if we're subscribed to a guild's chat.
   */
  isSubscribed(guildId: string): boolean {
    return this.subscribedGuilds.has(guildId);
  }

  /**
   * Get all currently subscribed guild IDs.
   */
  getSubscribedGuilds(): string[] {
    return Array.from(this.subscribedGuilds);
  }

  /**
   * Clean up all subscriptions.
   */
  async cleanup(): Promise<void> {
    for (const guildId of this.subscribedGuilds) {
      const channel = `guild:${guildId}:chat`;
      await this.messageBus.unsubscribe(channel);
    }
    this.subscribedGuilds.clear();
  }
}
