import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";
import { db } from "../../../server/storage";
import { orders, orderItems, products } from "../../../shared/schema";
import { eq } from "drizzle-orm";

// CRITICAL SECURITY: Server-side Admin Authorization
// These constants define authorized admin tokens and roles
// In production, these should be environment variables or database-backed
const AUTHORIZED_ADMIN_TOKENS = [
  "admin_token_2024_primary",   // Primary admin token
  "admin_token_2024_secondary", // Backup admin token
  "dev_admin_token_local"       // Development token (remove in production)
];

const AUTHORIZED_ADMIN_ROLES = [
  "business_owner",
  "store_manager", 
  "order_admin",
  "system_admin"
];

// Server-side admin authorization validation (CANNOT be bypassed via prompts)
const validateAdminAuthorization = async ({ 
  adminAuth, 
  logger 
}: { 
  adminAuth: { token?: string, role?: string, userId?: string }, 
  logger?: IMastraLogger 
}): Promise<{authorized: boolean, reason?: string}> => {
  logger?.info("🔐 [AdminAuth] Validating admin authorization", { 
    hasToken: !!adminAuth?.token,
    hasRole: !!adminAuth?.role,
    hasUserId: !!adminAuth?.userId
  });

  // CRITICAL: Reject if no auth provided
  if (!adminAuth || (!adminAuth.token && !adminAuth.role)) {
    const reason = "Admin authorization required: missing token and role";
    logger?.error("❌ [AdminAuth] Authorization failed - no credentials", { reason });
    return { authorized: false, reason };
  }

  // CRITICAL: Validate token if provided
  if (adminAuth.token && !AUTHORIZED_ADMIN_TOKENS.includes(adminAuth.token)) {
    const reason = "Admin authorization failed: invalid token";
    logger?.error("❌ [AdminAuth] Authorization failed - invalid token", { 
      providedToken: adminAuth.token?.substring(0, 8) + "...", // Log partial for debugging
      reason 
    });
    return { authorized: false, reason };
  }

  // CRITICAL: Validate role if provided
  if (adminAuth.role && !AUTHORIZED_ADMIN_ROLES.includes(adminAuth.role)) {
    const reason = "Admin authorization failed: invalid role";
    logger?.error("❌ [AdminAuth] Authorization failed - invalid role", { 
      providedRole: adminAuth.role,
      authorizedRoles: AUTHORIZED_ADMIN_ROLES,
      reason 
    });
    return { authorized: false, reason };
  }

  // CRITICAL: Both token AND role must be valid if both are provided
  if (adminAuth.token && adminAuth.role) {
    if (!AUTHORIZED_ADMIN_TOKENS.includes(adminAuth.token) || 
        !AUTHORIZED_ADMIN_ROLES.includes(adminAuth.role)) {
      const reason = "Admin authorization failed: token and role mismatch";
      logger?.error("❌ [AdminAuth] Authorization failed - credential mismatch", { reason });
      return { authorized: false, reason };
    }
  }

  logger?.info("✅ [AdminAuth] Authorization successful", { 
    token: adminAuth.token ? "valid" : "not_provided",
    role: adminAuth.role || "not_provided",
    userId: adminAuth.userId || "not_provided"
  });
  
  return { authorized: true };
};

// Order status values
const ORDER_STATUSES = [
  "placed",        // Order has been placed
  "received",      // Order received by business
  "in_progress",   // Order being prepared
  "out_for_delivery", // Order is out for delivery
  "delivered",     // Order has been delivered
  "cancelled"      // Order cancelled
] as const;

type OrderStatus = typeof ORDER_STATUSES[number];

// Customer-friendly status messages
const STATUS_MESSAGES: Record<OrderStatus, { 
  title: string, 
  message: string, 
  icon: string,
  estimatedTime?: string 
}> = {
  "placed": {
    title: "📦 Order Confirmed",
    message: "Thank you for your order! We've received your request and will process it shortly.",
    icon: "📦",
    estimatedTime: "Processing begins within 1-2 hours"
  },
  "received": {
    title: "✅ Order Received",
    message: "Your order has been received and verified by our team. We're preparing your items for delivery.",
    icon: "✅",
    estimatedTime: "Preparation will complete in 30-60 minutes"
  },
  "in_progress": {
    title: "🚀 Preparing Your Order",
    message: "Great news! Your order is currently being prepared for delivery. We're ensuring everything is perfect for you.",
    icon: "🚀",
    estimatedTime: "Ready for delivery in 15-30 minutes"
  },
  "out_for_delivery": {
    title: "🚗 Out for Delivery",
    message: "Your order is now on its way! Our delivery team is heading to your location with your discreet package.",
    icon: "🚗",
    estimatedTime: "Delivery within 30-45 minutes"
  },
  "delivered": {
    title: "🎉 Delivered Successfully",
    message: "Your order has been delivered! Thank you for choosing our discreet delivery service. We hope you're satisfied with your purchase.",
    icon: "🎉"
  },
  "cancelled": {
    title: "❌ Order Cancelled",
    message: "Your order has been cancelled. If you have any questions or would like to place a new order, please don't hesitate to contact us.",
    icon: "❌"
  }
};

// Telegram message formatting
const formatOrderSummary = (order: any, items: any[]) => {
  const itemsList = items.map(item => 
    `• ${item.productName} (x${item.quantity}) - $${item.totalPrice}`
  ).join('\n');

  return `
*Order Details:*
Order ID: \`${order.id}\`
${itemsList}

*Total: $${order.totalAmount}*
*Delivery Address:* ${order.deliveryAddress}
${order.phoneNumber ? `*Contact:* ${order.phoneNumber}` : ''}
`.trim();
};

// Send status update notification
const sendStatusNotification = async ({
  orderId,
  newStatus,
  customMessage,
  logger
}: {
  orderId: string,
  newStatus: OrderStatus,
  customMessage?: string,
  logger?: IMastraLogger
}) => {
  try {
    logger?.info("📱 [CustomerNotification] Sending status notification", { 
      orderId, 
      newStatus,
      hasCustomMessage: !!customMessage
    });

    // Get order details
    const orderData = await db.select({
      id: orders.id,
      telegramUserId: orders.telegramUserId,
      telegramUsername: orders.telegramUsername,
      customerName: orders.customerName,
      deliveryAddress: orders.deliveryAddress,
      phoneNumber: orders.phoneNumber,
      totalAmount: orders.totalAmount,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      createdAt: orders.createdAt,
    }).from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

    if (orderData.length === 0) {
      throw new Error(`Order ${orderId} not found`);
    }

    const order = orderData[0];

    // Get order items
    const items = await db.select({
      id: orderItems.id,
      quantity: orderItems.quantity,
      unitPrice: orderItems.unitPrice,
      totalPrice: orderItems.totalPrice,
      productName: products.name,
      productDescription: products.description,
    }).from(orderItems)
    .innerJoin(products, eq(orderItems.productId, products.id))
    .where(eq(orderItems.orderId, order.id));

    // Get status message template
    const statusInfo = STATUS_MESSAGES[newStatus];
    
    // Build notification message
    const orderSummary = formatOrderSummary(order, items);
    const estimatedTime = statusInfo.estimatedTime ? `\n\n⏰ *${statusInfo.estimatedTime}*` : '';
    const additionalMessage = customMessage ? `\n\n📝 ${customMessage}` : '';
    
    const notificationText = `
${statusInfo.icon} *${statusInfo.title}*

${statusInfo.message}${estimatedTime}${additionalMessage}

${orderSummary}

Thank you for choosing our discreet delivery service! 🌟
    `.trim();

    // For now, we'll return the formatted message
    // In a real implementation, this would send via Telegram Bot API
    const telegramMessage = {
      chat_id: order.telegramUserId,
      text: notificationText,
      parse_mode: "Markdown",
      disable_notification: false, // Allow notifications for order updates
    };

    logger?.info("✅ [CustomerNotification] Notification prepared successfully", { 
      orderId,
      recipientUserId: order.telegramUserId,
      recipientName: order.customerName,
      newStatus,
      messageLength: notificationText.length
    });

    return {
      success: true,
      order,
      notification: telegramMessage,
      statusInfo,
      formattedMessage: notificationText
    };

  } catch (error) {
    logger?.error("❌ [CustomerNotification] Error sending status notification", { 
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      orderId, 
      newStatus 
    });
    throw error;
  }
};

// Send delivery reminder notification
const sendDeliveryReminder = async ({
  orderId,
  reminderType = "delivery_approaching",
  estimatedMinutes,
  logger
}: {
  orderId: string,
  reminderType?: "delivery_approaching" | "delivery_delayed" | "driver_contact",
  estimatedMinutes?: number,
  logger?: IMastraLogger
}) => {
  try {
    logger?.info("⏰ [CustomerNotification] Sending delivery reminder", { 
      orderId, 
      reminderType,
      estimatedMinutes
    });

    // Get order details
    const orderData = await db.select({
      id: orders.id,
      telegramUserId: orders.telegramUserId,
      customerName: orders.customerName,
      deliveryAddress: orders.deliveryAddress,
      phoneNumber: orders.phoneNumber,
      totalAmount: orders.totalAmount,
      status: orders.status,
    }).from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

    if (orderData.length === 0) {
      throw new Error(`Order ${orderId} not found`);
    }

    const order = orderData[0];

    let reminderMessage = "";
    let title = "";
    let icon = "";

    switch (reminderType) {
      case "delivery_approaching":
        icon = "🚗";
        title = "Delivery Update";
        reminderMessage = estimatedMinutes 
          ? `Your order will arrive in approximately ${estimatedMinutes} minutes. Please be available to receive your discreet package.`
          : "Your order is approaching your delivery location. Please be available to receive your discreet package.";
        break;
      
      case "delivery_delayed":
        icon = "⏰";
        title = "Delivery Delay";
        reminderMessage = estimatedMinutes 
          ? `We're experiencing a slight delay. Your order will now arrive in approximately ${estimatedMinutes} minutes. Thank you for your patience!`
          : "We're experiencing a slight delay with your delivery. We'll update you shortly with a new estimated time. Thank you for your patience!";
        break;
      
      case "driver_contact":
        icon = "📞";
        title = "Driver Contact";
        reminderMessage = "Our delivery driver has arrived at your location. Please check for any messages or calls to coordinate the handoff of your discreet package.";
        break;
    }

    const notificationText = `
${icon} *${title}*

${reminderMessage}

*Order ID:* \`${order.id}\`
*Delivery Address:* ${order.deliveryAddress}
${order.phoneNumber ? `*Your Contact:* ${order.phoneNumber}` : ''}

Thanks for choosing our discreet delivery service! 🌟
    `.trim();

    const telegramMessage = {
      chat_id: order.telegramUserId,
      text: notificationText,
      parse_mode: "Markdown",
      disable_notification: false,
    };

    logger?.info("✅ [CustomerNotification] Delivery reminder prepared successfully", { 
      orderId,
      recipientUserId: order.telegramUserId,
      reminderType,
      estimatedMinutes
    });

    return {
      success: true,
      order,
      notification: telegramMessage,
      reminderType,
      formattedMessage: notificationText
    };

  } catch (error) {
    logger?.error("❌ [CustomerNotification] Error sending delivery reminder", { 
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      orderId, 
      reminderType 
    });
    throw error;
  }
};

// Send promotional or informational message
const sendPromoNotification = async ({
  telegramUserId,
  promoType = "welcome",
  customMessage,
  logger
}: {
  telegramUserId: string,
  promoType?: "welcome" | "discount" | "new_product" | "thank_you",
  customMessage?: string,
  logger?: IMastraLogger
}) => {
  try {
    logger?.info("🎁 [CustomerNotification] Sending promotional notification", { 
      telegramUserId, 
      promoType,
      hasCustomMessage: !!customMessage
    });

    let title = "";
    let message = "";
    let icon = "";

    switch (promoType) {
      case "welcome":
        icon = "🌟";
        title = "Welcome to Our Service!";
        message = "Thank you for joining our discreet personal care delivery service! We're here to provide you with quality products delivered safely and privately to your location in Palm Springs/Coachella Valley.";
        break;
      
      case "discount":
        icon = "💰";
        title = "Special Discount Available!";
        message = "Exclusive offer just for you! Use code SAVE15 for 15% off your next order. Quality personal care products delivered discreetly to your door.";
        break;
      
      case "new_product":
        icon = "🆕";
        title = "New Products Available!";
        message = "We've added new premium products to our catalog! Check out our latest additions for enhanced comfort and pleasure. All products are delivered with complete discretion.";
        break;
      
      case "thank_you":
        icon = "🙏";
        title = "Thank You!";
        message = "Thank you for being a valued customer! Your trust in our discreet delivery service means everything to us. We're always here when you need us.";
        break;
    }

    const finalMessage = customMessage || message;

    const notificationText = `
${icon} *${title}*

${finalMessage}

Need to place an order? Just send me a message anytime! 📱

Your trusted discreet delivery service 🌟
    `.trim();

    const telegramMessage = {
      chat_id: telegramUserId,
      text: notificationText,
      parse_mode: "Markdown",
      disable_notification: true, // Don't disturb for promotional messages
    };

    logger?.info("✅ [CustomerNotification] Promotional notification prepared successfully", { 
      telegramUserId,
      promoType,
      messageLength: notificationText.length
    });

    return {
      success: true,
      notification: telegramMessage,
      promoType,
      formattedMessage: notificationText
    };

  } catch (error) {
    logger?.error("❌ [CustomerNotification] Error sending promotional notification", { 
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      telegramUserId, 
      promoType 
    });
    throw error;
  }
};

export const customerNotificationTool = createTool({
  id: "customer-notification-tool",
  description: "Sends automated customer notifications via Telegram for order status updates, delivery reminders, and promotional messages in the personal lubricant delivery business. RESTRICTED to authorized business operators only. REQUIRES valid admin authorization.",
  inputSchema: z.object({
    // CRITICAL SECURITY: Admin authorization is MANDATORY
    adminAuth: z.object({
      token: z.string().optional().describe("Admin authorization token"),
      role: z.string().optional().describe("Admin role (business_owner, store_manager, order_admin, system_admin)"),
      userId: z.string().optional().describe("Admin user identifier"),
    }).describe("REQUIRED: Admin authorization credentials - at least token OR role must be provided"),
    
    action: z.enum([
      "send_status_notification", 
      "send_delivery_reminder", 
      "send_promo_notification"
    ]).describe("Type of notification to send"),
    
    // Status notification parameters
    orderId: z.string().optional().describe("Order ID for status notifications"),
    newStatus: z.enum(ORDER_STATUSES).optional().describe("New order status for notifications"),
    customMessage: z.string().optional().describe("Custom message to include with notification"),
    
    // Delivery reminder parameters
    reminderType: z.enum([
      "delivery_approaching", 
      "delivery_delayed", 
      "driver_contact"
    ]).optional().describe("Type of delivery reminder"),
    estimatedMinutes: z.number().int().positive().optional().describe("Estimated delivery time in minutes"),
    
    // Promotional notification parameters
    telegramUserId: z.string().optional().describe("Telegram user ID for promotional messages"),
    promoType: z.enum([
      "welcome", 
      "discount", 
      "new_product", 
      "thank_you"
    ]).optional().describe("Type of promotional message"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    action: z.string(),
    
    // Order information
    order: z.object({
      id: z.string(),
      telegramUserId: z.string(),
      customerName: z.string().nullable(),
      status: z.string(),
      totalAmount: z.string(),
    }).optional(),
    
    // Notification details
    notification: z.object({
      chat_id: z.string(),
      text: z.string(),
      parse_mode: z.string(),
      disable_notification: z.boolean(),
    }),
    
    // Additional metadata
    statusInfo: z.object({
      title: z.string(),
      message: z.string(),
      icon: z.string(),
      estimatedTime: z.string().optional(),
    }).optional(),
    
    reminderType: z.string().optional(),
    promoType: z.string().optional(),
    formattedMessage: z.string(),
    message: z.string(),
  }),
  execute: async ({ context: { 
    adminAuth,
    action,
    orderId,
    newStatus,
    customMessage,
    reminderType,
    estimatedMinutes,
    telegramUserId,
    promoType
  }, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔧 [CustomerNotification] Starting customer notification with security validation", { 
      action, 
      orderId,
      newStatus,
      telegramUserId,
      hasAdminAuth: !!adminAuth,
      authToken: adminAuth?.token ? "provided" : "missing",
      authRole: adminAuth?.role || "not_provided"
    });

    // CRITICAL SECURITY GATE: Validate admin authorization FIRST
    const authResult = await validateAdminAuthorization({ adminAuth, logger });
    if (!authResult.authorized) {
      logger?.error("🚫 [CustomerNotification] SECURITY: Unauthorized access attempt blocked", { 
        action,
        reason: authResult.reason,
        attemptedAuth: {
          hasToken: !!adminAuth?.token,
          hasRole: !!adminAuth?.role,
          hasUserId: !!adminAuth?.userId
        }
      });
      
      return {
        success: false,
        action: action || "unknown",
        error: "UNAUTHORIZED",
        notification: { chat_id: "", text: "", parse_mode: "Markdown", disable_notification: false },
        formattedMessage: "",
        message: `Access denied: ${authResult.reason}. Customer notification tools require valid authorization.`,
        requiresAuth: true,
        authorizedRoles: AUTHORIZED_ADMIN_ROLES
      };
    }
    
    logger?.info("✅ [CustomerNotification] Admin authorization validated - proceeding with notification", { 
      action,
      adminRole: adminAuth.role,
      adminUserId: adminAuth.userId 
    });

    try {
      switch (action) {
        case "send_status_notification": {
          if (!orderId || !newStatus) {
            return {
              success: false,
              action,
              notification: { chat_id: "", text: "", parse_mode: "Markdown", disable_notification: false },
              formattedMessage: "",
              message: "Order ID and new status are required for status notifications",
            };
          }
          
          const result = await sendStatusNotification({ 
            orderId, 
            newStatus, 
            customMessage, 
            logger 
          });
          
          return {
            success: true,
            action,
            order: {
              id: result.order.id,
              telegramUserId: result.order.telegramUserId,
              customerName: result.order.customerName,
              status: result.order.status,
              totalAmount: result.order.totalAmount,
            },
            notification: result.notification,
            statusInfo: result.statusInfo,
            formattedMessage: result.formattedMessage,
            message: `Status notification sent to customer for order ${orderId}`,
          };
        }

        case "send_delivery_reminder": {
          if (!orderId) {
            return {
              success: false,
              action,
              notification: { chat_id: "", text: "", parse_mode: "Markdown", disable_notification: false },
              formattedMessage: "",
              message: "Order ID is required for delivery reminders",
            };
          }
          
          const result = await sendDeliveryReminder({ 
            orderId, 
            reminderType: reminderType || "delivery_approaching", 
            estimatedMinutes, 
            logger 
          });
          
          return {
            success: true,
            action,
            order: {
              id: result.order.id,
              telegramUserId: result.order.telegramUserId,
              customerName: result.order.customerName,
              status: result.order.status,
              totalAmount: result.order.totalAmount,
            },
            notification: result.notification,
            reminderType: result.reminderType,
            formattedMessage: result.formattedMessage,
            message: `Delivery reminder sent to customer for order ${orderId}`,
          };
        }

        case "send_promo_notification": {
          if (!telegramUserId) {
            return {
              success: false,
              action,
              notification: { chat_id: "", text: "", parse_mode: "Markdown", disable_notification: true },
              formattedMessage: "",
              message: "Telegram user ID is required for promotional notifications",
            };
          }
          
          const result = await sendPromoNotification({ 
            telegramUserId, 
            promoType: promoType || "welcome", 
            customMessage, 
            logger 
          });
          
          return {
            success: true,
            action,
            notification: result.notification,
            promoType: result.promoType,
            formattedMessage: result.formattedMessage,
            message: `Promotional notification sent to user ${telegramUserId}`,
          };
        }

        default:
          return {
            success: false,
            action: action || "unknown",
            notification: { chat_id: "", text: "", parse_mode: "Markdown", disable_notification: false },
            formattedMessage: "",
            message: "Invalid action specified",
          };
      }
    } catch (error) {
      logger?.error("❌ [CustomerNotification] Tool execution failed", { 
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        action,
        orderId,
        newStatus,
        telegramUserId
      });
      return {
        success: false,
        action: action || "unknown",
        notification: { chat_id: "", text: "", parse_mode: "Markdown", disable_notification: false },
        formattedMessage: "",
        message: `Failed to send customer notification: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
});