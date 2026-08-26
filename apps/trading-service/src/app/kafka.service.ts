import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Kafka, Consumer } from 'kafkajs';

@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaService.name);
  private kafka!: Kafka;
  private consumer!: Consumer;

  async onModuleInit() {
    const brokers = process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092'];
    this.logger.log(`Initializing Kafka client with brokers: ${brokers.join(', ')}`);

    this.kafka = new Kafka({
      clientId: 'trading-service',
      brokers: brokers,
    });

    this.consumer = this.kafka.consumer({ groupId: 'trading-service-group' });
    
    try {
      await this.consumer.connect();
      this.logger.log('Kafka Consumer connected successfully');
    } catch (err: any) {
      this.logger.debug(`Failed to connect Kafka Consumer: ${err.message}`);
    }
  }

  async onModuleDestroy() {
    await this.consumer.disconnect();
    this.logger.log(`Disconnected consumer.`);
  }

  /**
   * Subscribe to topic pattern (e.g. /stock-tick-./ )
   **/
  async subscribeToPattern(pattern: RegExp, callback: (topic: string, data: any) => void): Promise<void> {
    try {
      await this.consumer.subscribe({ topic: pattern, fromBeginning: false });

      await this.consumer.run({
        eachMessage: async ({ topic, message }) => {
          try {
            if (message.value) {
              const data = JSON.parse(message.value.toString());
              callback(topic, data);
            }
          } catch (e: any) {
            this.logger.error(`Failed parsing Kafka message: ${e.message}`);
          }
        },
      });

      this.logger.log(`Successfully registered Kafka consumer for pattern: ${pattern.toString()}`);
    } catch (err: any) {
      this.logger.error(`Failed to register consumer for pattern ${pattern.toString()}: ${err.message}`);
    }
  }
}
