import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { KafkaService } from './kafka.service';
import { OrderStatus, OrderSide } from '@prisma/client';

@Injectable()
export class TradingEngineService implements OnModuleInit {
  private readonly logger = new Logger(TradingEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafkaService: KafkaService,
  ) {}

  async onModuleInit() {
    // Listen to all stock ticks from Angel One and Fyers
    this.kafkaService.subscribeToPattern(/stock-tick-.*/, (topic, tick) => {
      this.processTick(tick);
    });
  }

  private async processTick(tick: any) {
    if (!tick || !tick.stock || !tick.lastTradedPrice) return;
    const ltp = tick.lastTradedPrice;
    const symbol = tick.stock;

    // 1. Process Pending Limit/Stop Orders
    await this.processPendingOrders(symbol, ltp);

    // 2. Process Price Alerts
    await this.processPriceAlerts(symbol, ltp);
  }

  private async processPendingOrders(symbol: string, ltp: number) {
    const pendingOrders = await this.prisma.paperOrder.findMany({
      where: { symbol, status: OrderStatus.PENDING }
    });

    for (const order of pendingOrders) {
      let shouldExecute = false;

      if (order.type === 'LIMIT') {
        if (order.side === 'BUY' && order.price && ltp <= order.price) {
          shouldExecute = true;
        } else if (order.side === 'SELL' && order.price && ltp >= order.price) {
          shouldExecute = true;
        }
      } else if (order.triggerPrice) { // Stop Loss Orders
        if (order.side === 'BUY' && ltp >= order.triggerPrice) {
          shouldExecute = true; // Buy Stop
        } else if (order.side === 'SELL' && ltp <= order.triggerPrice) {
          shouldExecute = true; // Sell Stop
        }
      }

      if (shouldExecute) {
        await this.executeOrder(order.id, ltp);
      }
    }
  }

  private async processPriceAlerts(symbol: string, ltp: number) {
    // Real-world implementation would need to track previous price to know direction of cross
    // For simplicity, we just trigger if it's within a 0.1% range or just directly crossed.
    const alerts = await this.prisma.priceAlert.findMany({
      where: { symbol, isTriggered: false }
    });

    for (const alert of alerts) {
      const margin = alert.targetPrice * 0.001; // 0.1%
      if (Math.abs(ltp - alert.targetPrice) <= margin) {
        await this.prisma.priceAlert.update({
          where: { id: alert.id },
          data: { isTriggered: true }
        });
        this.logger.log(`🚨 PRICE ALERT TRIGGERED: ${symbol} hit target ₹${alert.targetPrice} (LTP: ₹${ltp})`);
      }
    }
  }

  async executeOrder(orderId: string, executionPrice: number) {
    const order = await this.prisma.paperOrder.findUnique({ where: { id: orderId } });
    if (!order || order.status !== OrderStatus.PENDING) return;

    const totalValue = order.quantity * executionPrice;

    // Transaction to ensure atomicity
    await this.prisma.$transaction(async (tx) => {
      // 1. Mark Order Executed
      await tx.paperOrder.update({
        where: { id: orderId },
        data: { status: OrderStatus.EXECUTED, executedPrice: executionPrice }
      });

      // 2. Deduct/Add Balance
      const portfolio = await tx.userPortfolio.findUnique({ where: { userId: order.userId } });
      if (portfolio) {
        const balanceChange = order.side === 'BUY' ? -totalValue : totalValue;
        await tx.userPortfolio.update({
          where: { id: portfolio.id },
          data: { balance: portfolio.balance + balanceChange }
        });
      }

      // 3. Update Positions (Upsert)
      const existingPosition = await tx.paperPosition.findFirst({
        where: { userId: order.userId, symbol: order.symbol }
      });

      if (existingPosition) {
        const newQty = order.side === 'BUY' 
          ? existingPosition.quantity + order.quantity 
          : existingPosition.quantity - order.quantity;
        
        let newAvgPrice = existingPosition.averagePrice;
        let realizedPnL = existingPosition.realizedPnL;

        if (order.side === 'BUY' && existingPosition.quantity >= 0) {
          // Averaging up/down
          const totalCost = (existingPosition.quantity * existingPosition.averagePrice) + totalValue;
          newAvgPrice = newQty > 0 ? totalCost / newQty : 0;
        } else if (order.side === 'SELL' && existingPosition.quantity > 0) {
          // Realizing PnL
          const pnl = (executionPrice - existingPosition.averagePrice) * order.quantity;
          realizedPnL += pnl;
        }
        
        if (newQty === 0) {
           await tx.paperPosition.delete({ where: { id: existingPosition.id } });
        } else {
           await tx.paperPosition.update({
             where: { id: existingPosition.id },
             data: { quantity: newQty, averagePrice: newAvgPrice, realizedPnL }
           });
        }
      } else {
        if (order.side === 'BUY') {
          await tx.paperPosition.create({
            data: {
              userId: order.userId,
              symbol: order.symbol,
              quantity: order.quantity,
              averagePrice: executionPrice
            }
          });
        }
      }
    });

    this.logger.log(`✅ EXECUTED: ${order.side} ${order.quantity} ${order.symbol} @ ₹${executionPrice}`);
  }
}
