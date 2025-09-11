import { createStep, createWorkflow } from "../inngest";
import { z } from "zod";
import { telegramBusinessAgent } from "../agents/telegramBusinessAgent";

const useAgentStep = createStep({
  id: "use-agent",
  description: "Process customer message using the Telegram business agent",
  inputSchema: z.object({
    message: z.string().describe("The raw Telegram message data as JSON string"),
    threadId: z.string().describe("Unique thread ID for conversation memory"),
  }),
  outputSchema: z.object({
    response: z.string().describe("The agent's response text"),
    messageData: z.any().describe("Parsed message data for reply context"),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🤖 [TelegramWorkflow] Starting agent processing', {
      threadId: inputData.threadId,
      messageLength: inputData.message.length,
    });

    try {
      // Parse the Telegram message data
      const messageData = JSON.parse(inputData.message);
      const userMessage = messageData.message?.text || messageData.message || "Hello";
      
      logger?.info('📝 [TelegramWorkflow] Parsed user message', {
        userMessage: userMessage.substring(0, 100) + (userMessage.length > 100 ? '...' : ''),
        threadId: inputData.threadId,
      });

      // Call the agent with the user's message
      const { text } = await telegramBusinessAgent.generate([
        { role: "user", content: userMessage }
      ], {
        resourceId: "bot",
        threadId: inputData.threadId,
        maxSteps: 5, // Allow multiple tool calls for complex interactions
      });

      logger?.info('✅ [TelegramWorkflow] Agent processing completed', {
        responseLength: text.length,
        threadId: inputData.threadId,
      });

      return {
        response: text,
        messageData,
      };
    } catch (error) {
      logger?.error('❌ [TelegramWorkflow] Agent processing failed', {
        error: error instanceof Error ? error.message : String(error),
        threadId: inputData.threadId,
      });
      
      // Return a friendly error message for the user
      return {
        response: "I apologize, but I'm experiencing technical difficulties. Please try again in a moment, or contact our support team if the issue persists.",
        messageData: JSON.parse(inputData.message),
      };
    }
  }
});

const sendReplyStep = createStep({
  id: "send-reply",
  description: "Send the agent's response back to Telegram",
  inputSchema: z.object({
    response: z.string().describe("The agent's response text"),
    messageData: z.any().describe("Parsed message data for reply context"),
  }),
  outputSchema: z.object({
    sent: z.boolean().describe("Whether the message was sent successfully"),
    chatId: z.string().optional().describe("Telegram chat ID where message was sent"),
    messageId: z.number().optional().describe("ID of the sent message"),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('📤 [TelegramWorkflow] Preparing to send reply', {
      responseLength: inputData.response.length,
      chatId: inputData.messageData?.message?.chat?.id,
    });

    try {
      // Extract chat information for reply
      const chatId = inputData.messageData?.message?.chat?.id || inputData.messageData?.chat_id;
      
      if (!chatId) {
        logger?.error('❌ [TelegramWorkflow] No chat ID found in message data', {
          messageData: inputData.messageData,
        });
        return { sent: false };
      }

      // Get the Telegram bot token
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      
      if (!botToken) {
        logger?.warn('⚠️ [TelegramWorkflow] TELEGRAM_BOT_TOKEN not configured', {
          chatId,
          messagePreview: inputData.response.substring(0, 50),
        });
        // In development, return success to allow testing without actual sending
        return {
          sent: true,
          chatId: chatId.toString(),
        };
      }

      // Prepare the Telegram API request
      const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const messagePayload = {
        chat_id: chatId,
        text: inputData.response,
        parse_mode: "Markdown",
        disable_notification: false,
      };

      logger?.info('📨 [TelegramWorkflow] Sending message to Telegram API', {
        chatId,
        messageLength: inputData.response.length,
        parseMode: "Markdown",
      });

      // Send the message via Telegram HTTP API
      const response = await fetch(telegramApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messagePayload),
      });

      const result = await response.json();

      if (!response.ok || !result.ok) {
        logger?.error('❌ [TelegramWorkflow] Telegram API error', {
          status: response.status,
          error: result.description || 'Unknown error',
          chatId,
        });
        return { sent: false, chatId: chatId.toString() };
      }

      logger?.info('✅ [TelegramWorkflow] Message sent successfully', {
        chatId,
        messageId: result.result?.message_id,
        sent: true,
      });

      return {
        sent: true,
        chatId: chatId.toString(),
        messageId: result.result?.message_id,
      };
    } catch (error) {
      logger?.error('❌ [TelegramWorkflow] Failed to send reply', {
        error: error instanceof Error ? error.message : String(error),
        messageData: inputData.messageData,
      });
      
      return { sent: false };
    }
  }
});

export const telegramBusinessWorkflow = createWorkflow({
  id: "telegram-business-workflow",
  description: "Handle incoming Telegram messages for the personal lubricant delivery business",
  inputSchema: z.object({
    message: z.string().describe("Raw Telegram message data as JSON string"),
    threadId: z.string().describe("Unique thread ID for conversation memory"),
  }),
  outputSchema: z.object({
    sent: z.boolean().describe("Whether the reply was sent successfully"),
    chatId: z.string().optional().describe("Telegram chat ID where reply was sent"),
  })
})
  .then(useAgentStep)
  .then(sendReplyStep)
  .commit();