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
import { FyersAuthService } from '../fyers-auth/fyers-auth.service';
const fyersDataSocket = require('fyers-api-v3').fyersDataSocket;

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  path: '/socket.io-fyers/',
})
export class WsFyersGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(WsFyersGateway.name);
  private fyersSocket: any = null;

  @WebSocketServer()
  server!: Server;

  constructor(private readonly fyersAuthService: FyersAuthService) {}

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth.token || client.handshake.query.token;
      if (!token) {
        throw new Error('No token provided');
      }
      
      const jwtSecret = process.env.JWT_PRIVATE_KEY || 'test-secret';
      jwt.verify(token, jwtSecret);
      
      this.logger.log(`Client connected: ${client.id}`);
      await this.ensureFyersSocketConnected();
    } catch (error: any) {
      this.logger.error(`Connection rejected: ${client.id} - ${error.message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  private async ensureFyersSocketConnected() {
    if (this.fyersSocket && this.fyersSocket.isConnected()) return;

    const token = await this.fyersAuthService.getAccessToken();
    if (!token) {
      this.logger.error('Cannot connect Fyers WS: No access token available.');
      return;
    }

    const appId = process.env.FYERS_APP_ID || '';
    const accessFormat = `${appId}:${token}`;

    this.fyersSocket = fyersDataSocket.getInstance(accessFormat, './logs', false);

    this.fyersSocket.on('connect', () => {
      this.logger.log('Connected to Fyers Data WebSocket successfully.');
      this.fyersSocket.mode(this.fyersSocket.FullMode); // Full mode for detailed candle data
    });

    this.fyersSocket.on('message', (message: any) => {
      // Emit the real-time data to all subscribed clients
      if (message && message.symbol) {
        this.server.to(message.symbol).emit('fyers_chart_tick', message);
      }
    });

    this.fyersSocket.on('error', (message: any) => {
      this.logger.error(`Fyers WS Error: ${JSON.stringify(message)}`);
    });

    this.fyersSocket.on('close', () => {
      this.logger.warn('Fyers WS closed.');
      this.fyersSocket = null;
    });

    this.fyersSocket.connect();
  }

  @SubscribeMessage('subscribe_fyers_chart')
  handleSubscribe(@MessageBody() data: { symbol: string }, @ConnectedSocket() client: Socket) {
    const symbol = data.symbol;
    if (!symbol) return;
    
    this.logger.log(`Client ${client.id} subscribed to ${symbol}`);
    client.join(symbol);
    
    if (this.fyersSocket && this.fyersSocket.isConnected()) {
      this.fyersSocket.subscribe([symbol]);
    }
    
    return { event: 'subscribed', symbol };
  }

  @SubscribeMessage('unsubscribe_fyers_chart')
  handleUnsubscribe(@MessageBody() data: { symbol: string }, @ConnectedSocket() client: Socket) {
    const symbol = data.symbol;
    if (!symbol) return;
    
    this.logger.log(`Client ${client.id} unsubscribed from ${symbol}`);
    client.leave(symbol);
    
    // Check if anyone else is still in the room before unsubscribing from Fyers
    const roomSize = this.server.sockets.adapter.rooms.get(symbol)?.size || 0;
    if (roomSize === 0 && this.fyersSocket && this.fyersSocket.isConnected()) {
      this.fyersSocket.unsubscribe([symbol]);
    }
    
    return { event: 'unsubscribed', symbol };
  }
}
