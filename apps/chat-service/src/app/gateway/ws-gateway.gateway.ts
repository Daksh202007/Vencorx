import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { RedisService } from '../redis/redis.service';
import { KafkaService } from '../kafka/kafka.service';
import { TimescaleService } from '../database/timescale.service';
import { AngelOneFetchService } from '../angel-one/angel-one-fetch.service';
import axios from 'axios';

@WebSocketGateway({
  cors: {
    // Restrict to known client origins — never use '*' in production
    origin: process.env.ALLOWED_ORIGIN === '*' ? true : (process.env.ALLOWED_ORIGIN?.split(',') ?? ['http://localhost:5173', 'app://-']),
    credentials: true,
  },
})
export class WsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(WsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly redisService: RedisService,
    private readonly kafkaService: KafkaService,
    private readonly timescaleService: TimescaleService,
    private readonly angelOneFetchService: AngelOneFetchService
  ) {}

  /**
   * Handle client socket connections and authenticate via JWT token
   */
  async handleConnection(socket: Socket) {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) {
        this.logger.warn(`Connection rejected: No token provided. Socket: ${socket.id}`);
        socket.disconnect();
        return;
      }

      // Verify JWT using the public key from env
      const publicKey = process.env.JWT_PUBLIC_KEY?.replace(/\\n/g, '\n') || '';
      const decoded = jwt.verify(token as string, publicKey, {
        algorithms: ['RS256'],
      }) as any;

      const userId = decoded.id || decoded.email;
      socket.data = { userId, email: decoded.email };

      // Register connection in Redis
      await this.redisService.registerSocket(socket.id, userId);
      this.logger.log(`Client connected: ${socket.id} (User: ${userId})`);
      
      // Welcome message
      socket.emit('welcome', { message: 'Successfully connected to Trading Gateway' });
    } catch (err: any) {
      this.logger.error(`Connection authentication failed: ${err.message}`);
      socket.disconnect();
    }
  }

  /**
   * Handle client socket disconnections and clean up Redis keys
   */
  async handleDisconnect(socket: Socket) {
    await this.redisService.deregisterSocket(socket.id, (idleStock) => {
      this.logger.log(`Stock "${idleStock}" has 0 active listeners. Unsubscribing from Angel One feed.`);
      this.angelOneFetchService.unsubscribeStock(idleStock);
    });
    this.logger.log(`Client disconnected: ${socket.id}`);
  }

  /**
   * Event: join_chat
   * Client joins a specific chat room (e.g. a specific stock group or general channel)
   */
  @SubscribeMessage('join_chat')
  async handleJoinChat(
    @MessageBody('room') room: string,
    @ConnectedSocket() socket: Socket
  ) {
    if (!room) return;
    socket.join(room);
    this.logger.log(`User ${socket.data.userId} joined room: ${room}`);
    
    // Fetch last few messages from DB to populate chat history
    try {
      const chatHistory = await this.timescaleService.getChatHistory(room, 50);
      socket.emit('chat_history', { room, history: chatHistory });
    } catch (e: any) {
      this.logger.error(`Failed to load chat history: ${e.message}`);
    }
  }

  /**
   * Event: send_message
   * User sends a chat message. It gets published to Kafka, stored in DB, and emitted to room.
   */
  @SubscribeMessage('send_message')
  async handleMessage(
    @MessageBody() payload: { room: string; message: string },
    @ConnectedSocket() socket: Socket
  ) {
    const { room, message } = payload;
    if (!room || !message) return;

    const chatEvent = {
      room,
      senderId: socket.data.userId,
      senderName: socket.data.email,
      message,
      timestamp: new Date().toISOString(),
    };

    // Broadcast live to the Socket.io room
    this.server.to(room).emit('new_message', chatEvent);

    // Publish to Kafka for asynchronous archiving to TimescaleDB
    await this.kafkaService.sendMessage('chat-messages', chatEvent);
  }

  /**
   * Event: subscribe_stocks
   * Client subscribes to live prices for a list of stocks
   */
  @SubscribeMessage('subscribe_stocks')
  async handleStockSubscription(
    @MessageBody('stocks') stocks: string[],
    @ConnectedSocket() socket: Socket
  ) {
    if (!stocks || !Array.isArray(stocks)) return;

    this.logger.log(`Socket ${socket.id} subscribing to stocks: ${stocks.join(', ')}`);

    for (const stock of stocks) {
      // Map socket to stock subscription in Redis
      await this.redisService.addSocketToStock(socket.id, stock);

      // Subscribe stock in Angel One pool connection
      this.angelOneFetchService.subscribeStock(stock);

      // Join the Socket.io room corresponding to the stock ticker
      socket.join(`stock:${stock}`);

      // Query previous/historical prices from TimescaleDB and emit to client
      try {
        const historicalData = await this.timescaleService.getHistoricalTicks(stock, 100);
        socket.emit('stock_history', { stock, ticks: historicalData });
      } catch (e: any) {
        this.logger.error(`Failed to load stock history for ${stock}: ${e.message}`);
      }

      // Register Kafka dynamic consumer to listen to price updates for this stock room
      await this.kafkaService.registerConsumer(
        `stock-tick-${stock}`,
        `ws-group-${stock}`,
        (tickData) => {
          // Push to all clients in the room
          this.server.to(`stock:${stock}`).emit('stock_tick', tickData);
        }
      );
    }
  }

  /**
   * Event: subscribe_fyers
   * Client subscribes to historical/live chart updates from Fyers
   */
  @SubscribeMessage('subscribe_fyers')
  async handleFyersSubscription(
    @MessageBody() payload: { symbol: string; resolution: string; from?: string; to?: string },
    @ConnectedSocket() socket: Socket
  ) {
    let { symbol, resolution, from, to } = payload;
    if (!symbol || !resolution) return;

    // Default to last 5 days if from/to not provided
    if (!from || !to) {
      const now = new Date();
      const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
      to = Math.floor(now.getTime() / 1000).toString();
      from = Math.floor(fiveDaysAgo.getTime() / 1000).toString();
    }

    const roomName = `fyers:${symbol}:${resolution}`;
    this.logger.log(`Socket ${socket.id} subscribing to Fyers: ${roomName}`);
    socket.join(roomName);

    try {
      // Trigger internal API call to Fyers Chart Service to ensure data is fetched and TSDB is updated
      await axios.post('http://fyers_chart_service:3002/api/fyers/internal/subscribe', {
        symbol,
        resolution,
        from,
        to
      });

      // Register dynamic Kafka consumer to listen to updates from Fyers Chart Service
      await this.kafkaService.registerConsumer(
        `fyers-chart-update-${symbol}-${resolution}`,
        `ws-group-fyers-${symbol}-${resolution}`,
        (updateData) => {
          // Push directly to clients exactly when TSDB was updated
          this.server.to(roomName).emit('fyers_chart_update', updateData);
        }
      );
    } catch (error: any) {
      this.logger.error(`Failed to subscribe to Fyers data: ${error.message}`);
      socket.emit('error', { message: 'Failed to subscribe to chart data' });
    }
  }

  @SubscribeMessage('unsubscribe_fyers')
  async handleFyersUnsubscription(
    @MessageBody() payload: { symbol: string; resolution: string },
    @ConnectedSocket() socket: Socket
  ) {
    const { symbol, resolution } = payload;
    if (!symbol || !resolution) return;

    const roomName = `fyers:${symbol}:${resolution}`;
    this.logger.log(`Socket ${socket.id} unsubscribing from Fyers: ${roomName}`);
    socket.leave(roomName);
  }
}
