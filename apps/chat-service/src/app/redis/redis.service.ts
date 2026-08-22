import { Injectable, OnModuleInit } from '@nestjs/common';
import { Redis } from '@upstash/redis';

@Injectable()
export class RedisService implements OnModuleInit {
  private client!: Redis;

  onModuleInit() {
    this.client = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL || '',
      token: process.env.UPSTASH_REDIS_REST_TOKEN || '',
    });
  }

  getClient(): Redis {
    return this.client;
  }

  /**
   * Store user websocket mapping
   * Key: user:socket:<socketId> -> Value: userId
   */
  async registerSocket(socketId: string, userId: string): Promise<void> {
    const key = `user:socket:${socketId}`;
    await this.client.setex(key, 86400, userId); // 1 day (86400s) TTL
  }

  /**
   * Remove user websocket mapping on disconnect and cleanup subscriptions
   */
  async deregisterSocket(socketId: string, onStockIdle?: (stock: string) => void): Promise<void> {
    const socketKey = `user:socket:${socketId}`;
    const userId = await this.client.get<string>(socketKey);
    
    if (userId) {
      // Clean up all stock mappings for this socket
      await this.cleanupSocketSubscriptions(socketId, onStockIdle);
      // Remove socket mapping
      await this.client.del(socketKey);
    }
  }

  /**
   * Associate a socket ID with a stock code using Redis Sets
   */
  async addSocketToStock(socketId: string, stock: string): Promise<void> {
    const stockSocketsKey = `stock:sockets:${stock}`;
    const socketStocksKey = `socket:stocks:${socketId}`;

    // Add socket to stock set
    await this.client.sadd(stockSocketsKey, socketId);
    // Add stock to socket set (for easy reverse lookup)
    await this.client.sadd(socketStocksKey, stock);
    // Add stock to global active stocks list
    await this.client.sadd('global:active_stocks', stock);
  }

  /**
   * Remove a socket ID from a stock code.
   * Returns true if no more sockets are listening to this stock.
   */
  async removeSocketFromStock(socketId: string, stock: string): Promise<boolean> {
    const stockSocketsKey = `stock:sockets:${stock}`;
    const socketStocksKey = `socket:stocks:${socketId}`;

    // Remove socket from stock set
    await this.client.srem(stockSocketsKey, socketId);
    // Remove stock from socket set
    await this.client.srem(socketStocksKey, stock);

    // Check if any sockets are left for this stock
    const remainingSockets = await this.client.scard(stockSocketsKey);
    if (remainingSockets === 0) {
      await this.client.del(stockSocketsKey);
      await this.client.srem('global:active_stocks', stock);
      return true; // Stock is now idle (0 listeners)
    }

    return false;
  }

  /**
   * Clean up all stock mapping associations when a socket disconnects.
   * Calls a callback when a stock becomes idle (0 active socket connections).
   */
  async cleanupSocketSubscriptions(socketId: string, onStockIdle?: (stock: string) => void): Promise<void> {
    const socketStocksKey = `socket:stocks:${socketId}`;
    const subscribedStocks = await this.client.smembers(socketStocksKey);

    for (const stock of subscribedStocks) {
      const isIdle = await this.removeSocketFromStock(socketId, stock);
      if (isIdle && onStockIdle) {
        onStockIdle(stock);
      }
    }

    await this.client.del(socketStocksKey);
  }

  /**
   * Remove a stock from the global active list (e.g. forced admin deletion)
   */
  async removeGlobalActiveStock(stock: string): Promise<void> {
    const stockSocketsKey = `stock:sockets:${stock}`;
    await this.client.del(stockSocketsKey);
    await this.client.srem('global:active_stocks', stock);
  }

  /**
   * Get all active stock symbols currently requested by any live WebSocket client
   */
  async getGlobalActiveStocks(): Promise<string[]> {
    return await this.client.smembers('global:active_stocks');
  }

  /**
   * Get all sockets listening to a specific stock
   */
  async getSocketsForStock(stock: string): Promise<string[]> {
    return await this.client.smembers(`stock:sockets:${stock}`);
  }

  /**
   * Map worker to active socket ID
   */
  async mapWorkerToSocket(socketId: string, workerId: string): Promise<void> {
    await this.client.set(`socket:worker:${socketId}`, workerId);
  }
}
