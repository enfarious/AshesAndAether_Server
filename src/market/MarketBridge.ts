/**
 * Bridge between the game server and the external Market Service
 *
 * Responsibilities:
 * - Forward player market commands to Market Service
 * - Subscribe to market events and update game world accordingly
 * - Handle item delivery and currency transfers
 */

import { logger } from '@/utils/logger';
import type { MessageBus } from '@/messaging/MessageBus';
import { WalletService } from '@/database/services/WalletService';
import { prisma } from '@/database/DatabaseService';

// Redis channels for Market Service communication
const CHANNELS = {
  MARKET_COMMANDS: 'market:commands', // Game Server -> Market Service
  MARKET_EVENTS: 'market:events', // Market Service -> Game Server
};

// Market message types
export enum MarketMessageType {
  // Commands (Game Server -> Market Service)
  ORDER_CREATE = 'order_create',
  ORDER_CANCEL = 'order_cancel',
  ORDER_FILL = 'order_fill',
  ORDER_QUERY = 'order_query',
  SLOT_UNLOCK = 'slot_unlock',

  // Events (Market Service -> Game Server)
  ORDER_CREATED = 'order_created',
  ORDER_CANCELLED = 'order_cancelled',
  ORDER_FILLED = 'order_filled',
  ORDER_EXPIRED = 'order_expired',
  ITEM_DELIVERED = 'item_delivered',
  CURRENCY_TRANSFERRED = 'currency_transferred',
  SLOT_UNLOCKED = 'slot_unlocked',
  QUERY_RESULT = 'query_result',
  ERROR = 'error',
}

// Message payload types
export interface MarketMessageEnvelope {
  type: MarketMessageType;
  requestId?: string; // For request-response correlation
  characterId?: string;
  payload: unknown;
  timestamp: number;
}

export interface OrderCreatePayload {
  characterId: string;
  regionId: string;
  itemTemplateId: string;
  inventoryItemId?: string;
  quantity: number;
  pricePerUnit: number;
  orderType: 'SELL' | 'BUY';
  orderScope: 'REGIONAL' | 'WORLD';
  stallId?: string;
  worldSlotIndex?: number;
}

export interface OrderFillPayload {
  buyerId: string;
  orderId: string;
  quantity?: number;
}

export interface OrderCancelPayload {
  characterId: string;
  orderId: string;
}

export interface ItemDeliveredPayload {
  characterId: string;
  itemTemplateId: string;
  inventoryItemId?: string;
  quantity: number;
  orderId: string;
  fromCharacterId: string;
}

export interface CurrencyTransferredPayload {
  characterId: string;
  amount: number;
  reason: string;
  orderId?: string;
}

export interface OrderCreatedPayload {
  orderId: string;
  sellerId: string;
  itemTemplateId: string;
  quantity: number;
  pricePerUnit: number;
  listingFee: number;
  orderScope: string;
  regionId: string;
}

export interface OrderFilledPayload {
  orderId: string;
  buyerId: string;
  sellerId: string;
  itemTemplateId: string;
  quantity: number;
  totalPrice: number;
  transactionFee: number;
}

export interface ErrorPayload {
  code: string;
  message: string;
  requestId?: string;
}

// Callback types for notifying game systems
export type ItemDeliveryCallback = (
  characterId: string,
  itemTemplateId: string,
  quantity: number,
  orderId: string
) => Promise<void>;

export type OrderEventCallback = (
  characterId: string,
  event: string,
  data: unknown
) => void;

export class MarketBridge {
  private messageBus: MessageBus;
  private connected = false;

  // Callbacks for game system integration
  private onItemDelivery: ItemDeliveryCallback | null = null;
  private onOrderEvent: OrderEventCallback | null = null;

  // Pending request tracking for request-response correlation
  private pendingRequests: Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timeout: NodeJS.Timeout }
  > = new Map();

  constructor(messageBus: MessageBus) {
    this.messageBus = messageBus;
  }

  /**
   * Start the market bridge
   */
  async start(): Promise<void> {
    if (!this.messageBus.isConnected()) {
      logger.warn('MessageBus not connected, market bridge cannot start');
      return;
    }

    // Subscribe to market events from Market Service
    await this.messageBus.subscribe(CHANNELS.MARKET_EVENTS, (envelope) => {
      this.handleMarketEvent(envelope.payload as MarketMessageEnvelope);
    });

    this.connected = true;
    logger.info('Market bridge started');
  }

  /**
   * Stop the market bridge
   */
  async stop(): Promise<void> {
    if (this.connected) {
      await this.messageBus.unsubscribe(CHANNELS.MARKET_EVENTS);
      this.connected = false;

      // Reject all pending requests
      for (const [requestId, pending] of this.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Market bridge stopped'));
        this.pendingRequests.delete(requestId);
      }
    }

    logger.info('Market bridge stopped');
  }

  /**
   * Set callback for item delivery events
   */
  setItemDeliveryCallback(callback: ItemDeliveryCallback): void {
    this.onItemDelivery = callback;
  }

  /**
   * Set callback for order events (for client notifications)
   */
  setOrderEventCallback(callback: OrderEventCallback): void {
    this.onOrderEvent = callback;
  }

  /**
   * Create a sell order
   */
  async createSellOrder(params: {
    characterId: string;
    regionId: string;
    inventoryItemId: string;
    quantity: number;
    pricePerUnit: number;
    orderScope: 'REGIONAL' | 'WORLD';
    stallId?: string;
    worldSlotIndex?: number;
  }): Promise<{ success: boolean; orderId?: string; error?: string }> {
    // Get the item to find its template
    const item = await prisma.inventoryItem.findUnique({
      where: { id: params.inventoryItemId },
      include: { template: true },
    });

    if (!item) {
      return { success: false, error: 'Item not found' };
    }

    if (item.characterId !== params.characterId) {
      return { success: false, error: 'Item does not belong to character' };
    }

    if (item.quantity < params.quantity) {
      return { success: false, error: 'Insufficient quantity' };
    }

    const payload: OrderCreatePayload = {
      characterId: params.characterId,
      regionId: params.regionId,
      itemTemplateId: item.itemTemplateId,
      inventoryItemId: params.inventoryItemId,
      quantity: params.quantity,
      pricePerUnit: params.pricePerUnit,
      orderType: 'SELL',
      orderScope: params.orderScope,
      stallId: params.stallId,
      worldSlotIndex: params.worldSlotIndex,
    };

    return this.sendCommand(MarketMessageType.ORDER_CREATE, payload);
  }

  /**
   * Create a buy order
   */
  async createBuyOrder(params: {
    characterId: string;
    regionId: string;
    itemTemplateId: string;
    quantity: number;
    pricePerUnit: number;
    orderScope: 'REGIONAL' | 'WORLD';
  }): Promise<{ success: boolean; orderId?: string; error?: string }> {
    // Verify character has sufficient funds
    const totalCost = params.quantity * params.pricePerUnit;
    const hasFunds = await WalletService.hasSufficientFunds(params.characterId, totalCost);

    if (!hasFunds) {
      return { success: false, error: 'Insufficient funds' };
    }

    const payload: OrderCreatePayload = {
      ...params,
      orderType: 'BUY',
    };

    return this.sendCommand(MarketMessageType.ORDER_CREATE, payload);
  }

  /**
   * Fill an order (buy from a sell order)
   */
  async fillOrder(params: {
    buyerId: string;
    orderId: string;
    quantity?: number;
  }): Promise<{ success: boolean; error?: string }> {
    const payload: OrderFillPayload = {
      buyerId: params.buyerId,
      orderId: params.orderId,
      quantity: params.quantity,
    };

    return this.sendCommand(MarketMessageType.ORDER_FILL, payload);
  }

  /**
   * Cancel an order
   */
  async cancelOrder(params: {
    characterId: string;
    orderId: string;
  }): Promise<{ success: boolean; error?: string }> {
    const payload: OrderCancelPayload = {
      characterId: params.characterId,
      orderId: params.orderId,
    };

    return this.sendCommand(MarketMessageType.ORDER_CANCEL, payload);
  }

  /**
   * Query orders (search)
   */
  async queryOrders(params: {
    regionId?: string;
    itemTemplateId?: string;
    orderType?: 'SELL' | 'BUY';
    orderScope?: 'REGIONAL' | 'WORLD';
    sellerId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ success: boolean; orders?: unknown[]; error?: string }> {
    return this.sendCommand(MarketMessageType.ORDER_QUERY, params);
  }

  /**
   * Send a command to the Market Service
   */
  private async sendCommand(
    type: MarketMessageType,
    payload: unknown,
    timeoutMs = 10000
  ): Promise<{ success: boolean; [key: string]: unknown }> {
    if (!this.connected) {
      return { success: false, error: 'Market bridge not connected' };
    }

    const requestId = crypto.randomUUID();

    const message: MarketMessageEnvelope = {
      type,
      requestId,
      payload,
      timestamp: Date.now(),
    };

    // Create a promise that will be resolved when we get a response
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Request timeout'));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });
    });

    // Publish the command
    await this.messageBus.publish(CHANNELS.MARKET_COMMANDS, {
      type: type as never,
      payload: message,
      timestamp: Date.now(),
    });

    try {
      const response = await responsePromise;
      return { success: true, ...(response as object) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Handle events from the Market Service
   */
  private async handleMarketEvent(event: MarketMessageEnvelope): Promise<void> {
    logger.debug({ event }, 'Received market event');

    // Check if this is a response to a pending request
    if (event.requestId && this.pendingRequests.has(event.requestId)) {
      const pending = this.pendingRequests.get(event.requestId)!;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(event.requestId);

      if (event.type === MarketMessageType.ERROR) {
        pending.reject(new Error((event.payload as ErrorPayload).message));
      } else {
        pending.resolve(event.payload);
      }
      return;
    }

    // Handle broadcast events
    switch (event.type) {
      case MarketMessageType.ITEM_DELIVERED:
        await this.handleItemDelivered(event.payload as ItemDeliveredPayload);
        break;

      case MarketMessageType.CURRENCY_TRANSFERRED:
        await this.handleCurrencyTransferred(event.payload as CurrencyTransferredPayload);
        break;

      case MarketMessageType.ORDER_CREATED:
        this.notifyOrderEvent(
          (event.payload as OrderCreatedPayload).sellerId,
          'order_created',
          event.payload
        );
        break;

      case MarketMessageType.ORDER_FILLED:
        const filledPayload = event.payload as OrderFilledPayload;
        this.notifyOrderEvent(filledPayload.sellerId, 'order_filled', event.payload);
        this.notifyOrderEvent(filledPayload.buyerId, 'order_filled', event.payload);
        break;

      case MarketMessageType.ORDER_CANCELLED:
        this.notifyOrderEvent(event.characterId!, 'order_cancelled', event.payload);
        break;

      case MarketMessageType.ORDER_EXPIRED:
        this.notifyOrderEvent(event.characterId!, 'order_expired', event.payload);
        break;

      default:
        logger.warn({ event }, 'Unknown market event type');
    }
  }

  /**
   * Handle item delivery from Market Service
   */
  private async handleItemDelivered(payload: ItemDeliveredPayload): Promise<void> {
    logger.info({ payload }, 'Processing item delivery');

    try {
      // Add item to character's inventory
      if (payload.inventoryItemId) {
        // Transfer existing item to new owner
        await prisma.inventoryItem.update({
          where: { id: payload.inventoryItemId },
          data: { characterId: payload.characterId },
        });
      } else {
        // Create new item instance
        await prisma.inventoryItem.create({
          data: {
            characterId: payload.characterId,
            itemTemplateId: payload.itemTemplateId,
            quantity: payload.quantity,
          },
        });
      }

      // Notify via callback if set
      if (this.onItemDelivery) {
        await this.onItemDelivery(
          payload.characterId,
          payload.itemTemplateId,
          payload.quantity,
          payload.orderId
        );
      }

      logger.info(
        { characterId: payload.characterId, itemTemplateId: payload.itemTemplateId, quantity: payload.quantity },
        'Item delivered successfully'
      );
    } catch (error) {
      logger.error({ error, payload }, 'Failed to process item delivery');
    }
  }

  /**
   * Handle currency transfer from Market Service
   */
  private async handleCurrencyTransferred(payload: CurrencyTransferredPayload): Promise<void> {
    logger.info({ payload }, 'Processing currency transfer');

    try {
      await WalletService.addGold(payload.characterId, payload.amount, payload.reason);

      this.notifyOrderEvent(payload.characterId, 'currency_received', {
        amount: payload.amount,
        reason: payload.reason,
        orderId: payload.orderId,
      });
    } catch (error) {
      logger.error({ error, payload }, 'Failed to process currency transfer');
    }
  }

  /**
   * Notify a character of an order event (via callback)
   */
  private notifyOrderEvent(characterId: string, event: string, data: unknown): void {
    if (this.onOrderEvent) {
      this.onOrderEvent(characterId, event, data);
    }
  }

  /**
   * Check if bridge is connected
   */
  isConnected(): boolean {
    return this.connected;
  }
}
