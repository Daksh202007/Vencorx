import { ConsoleLogger, Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class TelegramLoggerService extends ConsoleLogger {
  private readonly telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  private readonly telegramChatId = process.env.TELEGRAM_CHAT_ID;

  constructor() {
    super();
    // Default context if none provided
    this.setContext('Application');
  }

  error(message: any, stack?: string, context?: string) {
    // 1. Call the original console.error so it still prints to the terminal
    super.error(message, stack, context);

    // 2. Send the error to Telegram if configured
    this.sendToTelegram(message, context);
  }

  private async sendToTelegram(message: any, context?: string) {
    if (!this.telegramBotToken || !this.telegramChatId) {
      return; // Silently skip if not configured
    }

    const ctx = context || this.context;
    
    // Format the message nicely for Telegram (Markdown)
    const text = `🚨 *Fyers Chart Service Error* 🚨\n\n*Context:* ${ctx}\n*Error:* \n\`\`\`\n${
      typeof message === 'object' ? JSON.stringify(message, null, 2) : message
    }\n\`\`\``;

    try {
      // Fire and forget. No await, so it doesn't block the application flow.
      axios.post(`https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`, {
        chat_id: this.telegramChatId,
        text,
        parse_mode: 'Markdown',
      }).catch(() => {
        // We MUST catch errors silently here. If Telegram API is down,
        // throwing an error here would cause a recursive infinite loop of errors!
      });
    } catch (e) {
      // Ignored
    }
  }
}
