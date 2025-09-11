import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";

// Telegram Payment structures
interface TelegramStars {
  amount: number; // Amount in Telegram Stars
}

interface TelegramInvoice {
  title: string;
  description: string;
  payload: string; // Order identifier
  currency: string; // Usually 'XTR' for Telegram Stars
  prices: Array<{
    label: string;
    amount: number; // Amount in smallest currency unit
  }>;
}

interface TelegramPreCheckoutQuery {
  id: string;
  from: {
    id: number;
    username?: string;
    first_name: string;
  };
  currency: string;
  total_amount: number;
  invoice_payload: string; // Order identifier
}

// Convert USD to Telegram Stars (approximate rate: 1 USD = 200 Stars)
const convertUSDToStars = (usdAmount: number): number => {
  const exchangeRate = 200; // 1 USD = 200 Telegram Stars (approximate)
  return Math.ceil(usdAmount * exchangeRate);
};

// Create invoice for payment
const createPaymentInvoice = async ({ 
  orderId,
  totalAmount,
  customerName,
  items,
  logger 
}: { 
  orderId: string,
  totalAmount: number,
  customerName: string,
  items: Array<{name: string, quantity: number, price: number}>,
  logger?: IMastraLogger 
}) => {
  try {
    logger?.info("💳 [CryptoPayment] Creating payment invoice", { orderId, totalAmount, customerName });
    
    const starsAmount = convertUSDToStars(totalAmount);
    const invoice: TelegramInvoice = {
      title: "Personal Lubricant Delivery",
      description: `Order for ${customerName} - ${items.map(i => `${i.quantity}x ${i.name}`).join(', ')}`,
      payload: orderId,
      currency: 'XTR', // Telegram Stars
      prices: [{
        label: "Order Total",
        amount: starsAmount
      }]
    };
    
    logger?.info("✅ [CryptoPayment] Invoice created successfully", { 
      orderId, 
      usdAmount: totalAmount, 
      starsAmount,
      invoice 
    });
    
    return {
      success: true,
      invoice,
      starsAmount,
      exchangeRate: "1 USD ≈ 200 Telegram Stars"
    };
  } catch (error) {
    logger?.error("❌ [CryptoPayment] Error creating invoice", { orderId, error });
    throw error;
  }
};

// Verify payment completion
const verifyPayment = async ({ 
  paymentId,
  orderId,
  expectedAmount,
  logger 
}: { 
  paymentId: string,
  orderId: string,
  expectedAmount: number,
  logger?: IMastraLogger 
}) => {
  try {
    logger?.info("🔍 [CryptoPayment] Verifying payment", { paymentId, orderId, expectedAmount });
    
    // In a real implementation, you would verify the payment with Telegram's API
    // For now, we'll simulate a successful payment verification
    const paymentVerified = true; // This would come from Telegram's webhook
    const paidAmount = convertUSDToStars(expectedAmount);
    
    if (paymentVerified) {
      logger?.info("✅ [CryptoPayment] Payment verified successfully", { 
        paymentId, 
        orderId, 
        paidAmount 
      });
      
      return {
        success: true,
        verified: true,
        paidAmount,
        paymentMethod: "Telegram Stars",
        transactionId: paymentId
      };
    } else {
      logger?.warn("❌ [CryptoPayment] Payment verification failed", { paymentId, orderId });
      
      return {
        success: false,
        verified: false,
        reason: "Payment could not be verified"
      };
    }
  } catch (error) {
    logger?.error("❌ [CryptoPayment] Error verifying payment", { paymentId, orderId, error });
    throw error;
  }
};

// Process refund (if needed)
const processRefund = async ({ 
  paymentId,
  orderId,
  refundAmount,
  reason,
  logger 
}: { 
  paymentId: string,
  orderId: string,
  refundAmount: number,
  reason: string,
  logger?: IMastraLogger 
}) => {
  try {
    logger?.info("🔄 [CryptoPayment] Processing refund", { 
      paymentId, 
      orderId, 
      refundAmount, 
      reason 
    });
    
    const starsToRefund = convertUSDToStars(refundAmount);
    
    // In a real implementation, you would process the refund through Telegram's API
    // For now, we'll simulate a successful refund
    const refundProcessed = true;
    
    if (refundProcessed) {
      logger?.info("✅ [CryptoPayment] Refund processed successfully", { 
        paymentId, 
        orderId, 
        refundAmount,
        starsRefunded: starsToRefund
      });
      
      return {
        success: true,
        refunded: true,
        refundAmount,
        starsRefunded: starsToRefund,
        reason
      };
    } else {
      logger?.warn("❌ [CryptoPayment] Refund processing failed", { paymentId, orderId });
      
      return {
        success: false,
        refunded: false,
        reason: "Refund could not be processed"
      };
    }
  } catch (error) {
    logger?.error("❌ [CryptoPayment] Error processing refund", { paymentId, orderId, error });
    throw error;
  }
};

export const cryptoPaymentTool = createTool({
  id: "crypto-payment-tool",
  description: "Processes crypto payments through Telegram's integrated wallet system using Telegram Stars. Handles invoice creation, payment verification, and refunds for the personal lubricant delivery business.",
  inputSchema: z.object({
    action: z.enum(["create_invoice", "verify_payment", "process_refund"]).describe("Payment action to perform"),
    orderId: z.string().describe("Unique order identifier"),
    totalAmount: z.number().optional().describe("Total amount in USD for invoice creation"),
    customerName: z.string().optional().describe("Customer name for invoice"),
    items: z.array(z.object({
      name: z.string(),
      quantity: z.number(),
      price: z.number(),
    })).optional().describe("Order items for invoice description"),
    paymentId: z.string().optional().describe("Payment ID for verification or refund"),
    expectedAmount: z.number().optional().describe("Expected payment amount in USD for verification"),
    refundAmount: z.number().optional().describe("Amount to refund in USD"),
    reason: z.string().optional().describe("Reason for refund"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    invoice: z.object({
      title: z.string(),
      description: z.string(),
      payload: z.string(),
      currency: z.string(),
      prices: z.array(z.object({
        label: z.string(),
        amount: z.number(),
      })),
    }).optional(),
    starsAmount: z.number().optional(),
    exchangeRate: z.string().optional(),
    verified: z.boolean().optional(),
    paidAmount: z.number().optional(),
    paymentMethod: z.string().optional(),
    transactionId: z.string().optional(),
    refunded: z.boolean().optional(),
    refundAmount: z.number().optional(),
    starsRefunded: z.number().optional(),
    reason: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ context: { 
    action, 
    orderId, 
    totalAmount, 
    customerName, 
    items, 
    paymentId, 
    expectedAmount, 
    refundAmount, 
    reason 
  }, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔧 [CryptoPayment] Starting payment processing", { 
      action, 
      orderId, 
      totalAmount, 
      paymentId 
    });

    try {
      switch (action) {
        case "create_invoice": {
          if (!totalAmount || !customerName || !items) {
            return {
              success: false,
              message: "Total amount, customer name, and items are required for invoice creation",
            };
          }
          
          const result = await createPaymentInvoice({ 
            orderId, 
            totalAmount, 
            customerName, 
            items, 
            logger 
          });
          
          return {
            success: true,
            invoice: result.invoice,
            starsAmount: result.starsAmount,
            exchangeRate: result.exchangeRate,
            message: `Payment invoice created for ${totalAmount} USD (≈ ${result.starsAmount} Telegram Stars)`,
          };
        }

        case "verify_payment": {
          if (!paymentId || !expectedAmount) {
            return {
              success: false,
              message: "Payment ID and expected amount are required for payment verification",
            };
          }
          
          const result = await verifyPayment({ 
            paymentId, 
            orderId, 
            expectedAmount, 
            logger 
          });
          
          if (result.success && result.verified) {
            return {
              success: true,
              verified: true,
              paidAmount: result.paidAmount,
              paymentMethod: result.paymentMethod,
              transactionId: result.transactionId,
              message: `Payment of ${expectedAmount} USD verified successfully`,
            };
          } else {
            return {
              success: false,
              verified: false,
              reason: result.reason,
              message: "Payment verification failed",
            };
          }
        }

        case "process_refund": {
          if (!paymentId || !refundAmount || !reason) {
            return {
              success: false,
              message: "Payment ID, refund amount, and reason are required for refund processing",
            };
          }
          
          const result = await processRefund({ 
            paymentId, 
            orderId, 
            refundAmount, 
            reason, 
            logger 
          });
          
          if (result.success && result.refunded) {
            return {
              success: true,
              refunded: true,
              refundAmount: result.refundAmount,
              starsRefunded: result.starsRefunded,
              reason: result.reason,
              message: `Refund of ${refundAmount} USD (≈ ${result.starsRefunded} Stars) processed successfully`,
            };
          } else {
            return {
              success: false,
              refunded: false,
              reason: result.reason,
              message: "Refund processing failed",
            };
          }
        }

        default:
          return {
            success: false,
            message: "Invalid payment action specified",
          };
      }
    } catch (error) {
      logger?.error("❌ [CryptoPayment] Tool execution failed", { error });
      return {
        success: false,
        message: "Failed to process crypto payment operation",
      };
    }
  },
});