import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Kafka, Producer, Consumer } from 'kafkajs';

@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaService.name);
  private kafka!: Kafka;
  private producer!: Producer;
  private consumers: Map<string, Consumer> = new Map();

  onModuleInit() {
    const brokers = process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092'];
    this.logger.log(`Initializing Kafka client with brokers: ${brokers.join(', ')}`);

    this.kafka = new Kafka({
      clientId: 'chat-service',
      brokers: brokers,
      // Optional: add SASL configuration if needed
    });

    this.producer = this.kafka.producer();
    this.connectProducer().catch((err) => {
      this.logger.warn(`Failed to connect Kafka Producer: ${err.message}. Running in offline/mock mode.`);
    });
  }

  private async connectProducer() {
    await this.producer.connect();
    this.logger.log('Kafka Producer connected successfully');
  }

  async onModuleDestroy() {
    await this.producer.disconnect();
    for (const [topic, consumer] of this.consumers.entries()) {
      await consumer.disconnect();
      this.logger.log(`Disconnected consumer for topic: ${topic}`);
    }
  }

  /**
   * Publish a message to a Kafka topic
   */
  async sendMessage(topic: string, message: any): Promise<void> {
    try {
      if (!this.producer) {
        throw new Error('Producer not initialized');
      }
      await this.producer.send({
        topic,
        messages: [{ value: JSON.stringify(message) }],
      });
      this.logger.verbose(`Published message to Kafka topic: ${topic}`);
    } catch (err: any) {
      this.logger.error(`Error sending message to Kafka: ${err.message}`);
      // Fallback/mock logging for local testing without active Kafka broker
      this.logger.log(`[Offline Mock Send] Topic: ${topic}, Msg: ${JSON.stringify(message)}`);
    }
  }

  /**
   * Register a dynamic consumer for a specific topic (e.g. per stock room/channel)
   */
  async registerConsumer(topic: string, groupId: string, callback: (data: any) => void): Promise<void> {
    try {
      const consumerKey = `${topic}:${groupId}`;
      if (this.consumers.has(consumerKey)) {
        return;
      }

      const consumer = this.kafka.consumer({ groupId });
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: false });

      await consumer.run({
        eachMessage: async ({ message }) => {
          try {
            if (message.value) {
              const data = JSON.parse(message.value.toString());
              callback(data);
            }
          } catch (e: any) {
            this.logger.error(`Failed parsing Kafka message: ${e.message}`);
          }
        },
      });

      this.consumers.set(consumerKey, consumer);
      this.logger.log(`Successfully registered Kafka consumer for topic: ${topic}`);
    } catch (err: any) {
      this.logger.error(`Failed to register consumer for topic ${topic}: ${err.message}`);
    }
  }

  /**
   * Unsubscribe / disconnect a consumer
   */
  async removeConsumer(topic: string, groupId: string): Promise<void> {
    const consumerKey = `${topic}:${groupId}`;
    const consumer = this.consumers.get(consumerKey);
    if (consumer) {
      await consumer.disconnect();
      this.consumers.delete(consumerKey);
      this.logger.log(`Removed Kafka consumer for topic: ${topic}`);
    }
  }
}
