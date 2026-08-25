import { Controller, Post, Body, Get, Param, Delete, UseGuards, Req } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from './prisma.service';
import { TradingEngineService } from './trading-engine.service';
import { OrderSide, OrderType } from '@prisma/client';
import { JwtAuthGuard, JwtPayload } from './auth/jwt-auth.guard';

/** Extend Express Request so TypeScript knows about request.user */
interface AuthRequest extends Request {
  user: JwtPayload;
}

@UseGuards(JwtAuthGuard)
@Controller('oms')
export class OMSController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tradingEngine: TradingEngineService
  ) {}

  /** Place a paper order. userId is taken from the verified JWT — never from the request body. */
  @Post('order')
  async placeOrder(
    @Req() req: AuthRequest,
    @Body() body: {
      symbol: string;
      side: OrderSide;
      type: OrderType;
      quantity: number;
      price?: number;
      triggerPrice?: number;
    }
  ) {
    // userId is extracted from the verified JWT payload — not trusted from the client body
    const userId = req.user.id;

    const order = await this.prisma.paperOrder.create({
      data: {
        userId,
        symbol: body.symbol,
        side: body.side,
        type: body.type,
        quantity: body.quantity,
        price: body.price,
        triggerPrice: body.triggerPrice,
      },
    });

    return { success: true, order };
  }

  /** Set a price alert. userId comes from the verified JWT. */
  @Post('alert')
  async setAlert(
    @Req() req: AuthRequest,
    @Body() body: { symbol: string; targetPrice: number }
  ) {
    const userId = req.user.id;

    const alert = await this.prisma.priceAlert.create({
      data: {
        userId,
        symbol: body.symbol,
        targetPrice: body.targetPrice,
      },
    });

    return { success: true, alert };
  }

  /** Get portfolio for the authenticated user only — ignores :userId param if it differs from token. */
  @Get('portfolio/:userId')
  async getPortfolio(@Req() req: AuthRequest, @Param('userId') _paramUserId: string) {
    // Always use userId from the verified JWT — the URL param is ignored for security
    const userId = req.user.id;

    let portfolio = await this.prisma.userPortfolio.findUnique({ where: { userId } });
    if (!portfolio) {
      portfolio = await this.prisma.userPortfolio.create({
        data: { userId, balance: 1000000.0 },
      });
    }

    const positions = await this.prisma.paperPosition.findMany({ where: { userId } });
    const orders = await this.prisma.paperOrder.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return { success: true, portfolio, positions, orders };
  }

  /** Cancel an order — verifies the order belongs to the authenticated user before cancelling. */
  @Delete('order/:orderId')
  async cancelOrder(@Req() req: AuthRequest, @Param('orderId') orderId: string) {
    const userId = req.user.id;

    // Ownership check: ensure this order belongs to the requesting user
    const order = await this.prisma.paperOrder.findUnique({ where: { id: orderId } });
    if (!order || order.userId !== userId) {
      return { success: false, error: 'Order not found or access denied' };
    }

    const updated = await this.prisma.paperOrder.update({
      where: { id: orderId },
      data: { status: 'CANCELLED' },
    });

    return { success: true, order: updated };
  }
}
