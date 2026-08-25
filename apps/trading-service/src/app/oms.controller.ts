import { Controller, Post, Body, Get, Param, Delete } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TradingEngineService } from './trading-engine.service';
import { OrderSide, OrderType } from '@prisma/client';

@Controller('oms')
export class OMSController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tradingEngine: TradingEngineService
  ) {}

  @Post('order')
  async placeOrder(@Body() body: { 
    userId: string, 
    symbol: string, 
    side: OrderSide, 
    type: OrderType, 
    quantity: number, 
    price?: number,
    triggerPrice?: number 
  }) {
    const order = await this.prisma.paperOrder.create({
      data: {
        userId: body.userId,
        symbol: body.symbol,
        side: body.side,
        type: body.type,
        quantity: body.quantity,
        price: body.price,
        triggerPrice: body.triggerPrice
      }
    });

    return { success: true, order };
  }

  @Post('alert')
  async setAlert(@Body() body: { userId: string, symbol: string, targetPrice: number }) {
    const alert = await this.prisma.priceAlert.create({
      data: {
        userId: body.userId,
        symbol: body.symbol,
        targetPrice: body.targetPrice
      }
    });

    return { success: true, alert };
  }

  @Get('portfolio/:userId')
  async getPortfolio(@Param('userId') userId: string) {
    let portfolio = await this.prisma.userPortfolio.findUnique({ where: { userId } });
    if (!portfolio) {
      portfolio = await this.prisma.userPortfolio.create({
        data: { userId, balance: 1000000.0 }
      });
    }

    const positions = await this.prisma.paperPosition.findMany({ where: { userId } });
    const orders = await this.prisma.paperOrder.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 20 });

    return { success: true, portfolio, positions, orders };
  }

  @Delete('order/:orderId')
  async cancelOrder(@Param('orderId') orderId: string) {
    const order = await this.prisma.paperOrder.update({
      where: { id: orderId },
      data: { status: 'CANCELLED' }
    });
    return { success: true, order };
  }
}
