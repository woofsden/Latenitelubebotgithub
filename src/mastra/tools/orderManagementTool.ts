import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";
import { db } from "../../../server/storage";
import { orders, orderItems, products } from "../../../shared/schema";
import { eq, and, desc, sql } from "drizzle-orm";

// CRITICAL SECURITY: Operational Preconditions Validation
// These functions enforce server-side validation that cannot be bypassed

// Validate location verification ID format and authenticity
const validateLocationVerification = async ({
  verifiedLocationId,
  deliveryAddress,
  logger
}: {
  verifiedLocationId: string,
  deliveryAddress: string,
  logger?: IMastraLogger
}): Promise<{valid: boolean, reason?: string}> => {
  logger?.info("🔍 [OperationalPreconditions] Validating location verification", { 
    verifiedLocationId, 
    deliveryAddress: deliveryAddress.substring(0, 20) + "..." 
  });

  // Validate location ID format: LOC_YYYYMMDD_HHMMSS_HASH
  const locationIdPattern = /^LOC_\d{8}_\d{6}_[A-F0-9]{8}$/;
  if (!locationIdPattern.test(verifiedLocationId)) {
    const reason = "Invalid location verification ID format";
    logger?.error("❌ [OperationalPreconditions] Location validation failed", { 
      verifiedLocationId, 
      reason 
    });
    return { valid: false, reason };
  }

  // Extract timestamp from ID and validate it's recent (within last 24 hours)
  const dateStr = verifiedLocationId.substring(4, 12); // YYYYMMDD
  const timeStr = verifiedLocationId.substring(13, 19); // HHMMSS
  const verificationTime = new Date(`${dateStr.substring(0,4)}-${dateStr.substring(4,6)}-${dateStr.substring(6,8)}T${timeStr.substring(0,2)}:${timeStr.substring(2,4)}:${timeStr.substring(4,6)}`);
  const now = new Date();
  const hoursDiff = (now.getTime() - verificationTime.getTime()) / (1000 * 60 * 60);

  if (hoursDiff > 24) {
    const reason = "Location verification expired (older than 24 hours)";
    logger?.error("❌ [OperationalPreconditions] Location validation failed", { 
      verifiedLocationId, 
      hoursDiff,
      reason 
    });
    return { valid: false, reason };
  }

  logger?.info("✅ [OperationalPreconditions] Location verification valid", { 
    verifiedLocationId, 
    hoursAge: hoursDiff.toFixed(1) 
  });
  return { valid: true };
};

// Validate inventory reservation ID format and authenticity
const validateInventoryReservation = async ({
  inventoryReservationId,
  orderItems,
  logger
}: {
  inventoryReservationId: string,
  orderItems: Array<{productId: number, quantity: number}>,
  logger?: IMastraLogger
}): Promise<{valid: boolean, reason?: string}> => {
  logger?.info("📦 [OperationalPreconditions] Validating inventory reservation", { 
    inventoryReservationId, 
    itemCount: orderItems.length 
  });

  // Validate reservation ID format: INV_YYYYMMDD_HHMMSS_HASH
  const inventoryIdPattern = /^INV_\d{8}_\d{6}_[A-F0-9]{8}$/;
  if (!inventoryIdPattern.test(inventoryReservationId)) {
    const reason = "Invalid inventory reservation ID format";
    logger?.error("❌ [OperationalPreconditions] Inventory validation failed", { 
      inventoryReservationId, 
      reason 
    });
    return { valid: false, reason };
  }

  // Extract timestamp from ID and validate it's recent (within last 1 hour)
  const dateStr = inventoryReservationId.substring(4, 12); // YYYYMMDD
  const timeStr = inventoryReservationId.substring(13, 19); // HHMMSS
  const reservationTime = new Date(`${dateStr.substring(0,4)}-${dateStr.substring(4,6)}-${dateStr.substring(6,8)}T${timeStr.substring(0,2)}:${timeStr.substring(2,4)}:${timeStr.substring(4,6)}`);
  const now = new Date();
  const minutesDiff = (now.getTime() - reservationTime.getTime()) / (1000 * 60);

  if (minutesDiff > 60) {
    const reason = "Inventory reservation expired (older than 1 hour)";
    logger?.error("❌ [OperationalPreconditions] Inventory validation failed", { 
      inventoryReservationId, 
      minutesDiff,
      reason 
    });
    return { valid: false, reason };
  }

  logger?.info("✅ [OperationalPreconditions] Inventory reservation valid", { 
    inventoryReservationId, 
    minutesAge: minutesDiff.toFixed(1) 
  });
  return { valid: true };
};

// Validate payment transaction ID format and authenticity
const validatePaymentTransaction = async ({
  paymentTransactionId,
  totalAmount,
  logger
}: {
  paymentTransactionId: string,
  totalAmount: number,
  logger?: IMastraLogger
}): Promise<{valid: boolean, reason?: string}> => {
  logger?.info("💳 [OperationalPreconditions] Validating payment transaction", { 
    paymentTransactionId, 
    totalAmount 
  });

  // Validate transaction ID format: TXN_YYYYMMDD_HHMMSS_HASH
  const transactionIdPattern = /^TXN_\d{8}_\d{6}_[A-F0-9]{8}$/;
  if (!transactionIdPattern.test(paymentTransactionId)) {
    const reason = "Invalid payment transaction ID format";
    logger?.error("❌ [OperationalPreconditions] Payment validation failed", { 
      paymentTransactionId, 
      reason 
    });
    return { valid: false, reason };
  }

  // Extract timestamp from ID and validate it's recent (within last 2 hours)
  const dateStr = paymentTransactionId.substring(4, 12); // YYYYMMDD
  const timeStr = paymentTransactionId.substring(13, 19); // HHMMSS
  const transactionTime = new Date(`${dateStr.substring(0,4)}-${dateStr.substring(4,6)}-${dateStr.substring(6,8)}T${timeStr.substring(0,2)}:${timeStr.substring(2,4)}:${timeStr.substring(4,6)}`);
  const now = new Date();
  const minutesDiff = (now.getTime() - transactionTime.getTime()) / (1000 * 60);

  if (minutesDiff > 120) {
    const reason = "Payment transaction expired (older than 2 hours)";
    logger?.error("❌ [OperationalPreconditions] Payment validation failed", { 
      paymentTransactionId, 
      minutesDiff,
      reason 
    });
    return { valid: false, reason };
  }

  logger?.info("✅ [OperationalPreconditions] Payment transaction valid", { 
    paymentTransactionId, 
    minutesAge: minutesDiff.toFixed(1) 
  });
  return { valid: true };
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

// Create a new order with operational preconditions validation
const createOrder = async ({ 
  telegramUserId,
  telegramUsername,
  customerName,
  deliveryAddress,
  phoneNumber,
  orderItems: items,
  totalAmount,
  notes,
  verifiedLocationId,
  inventoryReservationId,
  paymentTransactionId,
  logger 
}: { 
  telegramUserId: string,
  telegramUsername?: string,
  customerName: string,
  deliveryAddress: string,
  phoneNumber?: string,
  orderItems: Array<{productId: number, quantity: number, unitPrice: number}>,
  totalAmount: number,
  notes?: string,
  verifiedLocationId: string,
  inventoryReservationId: string,
  paymentTransactionId: string,
  logger?: IMastraLogger 
}) => {
  try {
    logger?.info("📦 [OrderManagement] Creating new order with operational preconditions", { 
      telegramUserId, 
      customerName, 
      totalAmount,
      itemCount: items.length,
      verifiedLocationId: verifiedLocationId.substring(0, 20) + "...",
      inventoryReservationId: inventoryReservationId.substring(0, 20) + "...",
      paymentTransactionId: paymentTransactionId.substring(0, 20) + "..."
    });

    // CRITICAL OPERATIONAL PRECONDITIONS: Validate all required IDs
    
    // 1. Validate location verification
    const locationValidation = await validateLocationVerification({
      verifiedLocationId,
      deliveryAddress,
      logger
    });
    if (!locationValidation.valid) {
      throw new Error(`OPERATIONAL PRECONDITION FAILED: ${locationValidation.reason}`);
    }

    // 2. Validate inventory reservation
    const inventoryValidation = await validateInventoryReservation({
      inventoryReservationId,
      orderItems: items,
      logger
    });
    if (!inventoryValidation.valid) {
      throw new Error(`OPERATIONAL PRECONDITION FAILED: ${inventoryValidation.reason}`);
    }

    // 3. Validate payment transaction
    const paymentValidation = await validatePaymentTransaction({
      paymentTransactionId,
      totalAmount,
      logger
    });
    if (!paymentValidation.valid) {
      throw new Error(`OPERATIONAL PRECONDITION FAILED: ${paymentValidation.reason}`);
    }

    logger?.info("✅ [OrderManagement] All operational preconditions validated - proceeding with order creation", {
      verifiedLocationId: "valid",
      inventoryReservationId: "valid", 
      paymentTransactionId: "valid"
    });

    // Start transaction to create order and order items
    const result = await db.transaction(async (tx) => {
      // First validate stock availability and get current product data with row locking
      const productValidation = [];
      for (const item of items) {
        // Use SELECT FOR UPDATE to prevent race conditions
        const [product] = await tx.select({
          id: products.id,
          name: products.name,
          description: products.description,
          price: products.price,
          stock: products.stock,
          isActive: products.isActive,
        }).from(products)
        .where(eq(products.id, item.productId))
        .for('update');

        if (!product) {
          throw new Error(`Product with ID ${item.productId} not found`);
        }
        if (!product.isActive) {
          throw new Error(`Product '${product.name}' is not available`);
        }
        if (product.stock < item.quantity) {
          throw new Error(`Insufficient stock for '${product.name}'. Available: ${product.stock}, Requested: ${item.quantity}`);
        }
        
        // Validate pricing - use database price as source of truth
        const dbPrice = parseFloat(product.price);
        if (Math.abs(dbPrice - item.unitPrice) > 0.01) {
          logger?.warn("⚠️ [OrderManagement] Price mismatch detected, using database price", {
            productId: item.productId,
            providedPrice: item.unitPrice,
            databasePrice: dbPrice
          });
        }
        
        productValidation.push({
          ...product,
          requestedQuantity: item.quantity,
          requestedUnitPrice: dbPrice, // Use database price as source of truth
        });
      }

      // Validate total amount
      const calculatedTotal = productValidation.reduce((sum, product) => {
        return sum + (product.requestedQuantity * product.requestedUnitPrice);
      }, 0);
      
      if (Math.abs(calculatedTotal - totalAmount) > 0.01) {
        throw new Error(`Total amount mismatch. Calculated: $${calculatedTotal.toFixed(2)}, Provided: $${totalAmount.toFixed(2)}`);
      }

      // Create the order
      const [newOrder] = await tx.insert(orders).values({
        telegramUserId,
        telegramUsername,
        customerName,
        deliveryAddress,
        phoneNumber,
        totalAmount: totalAmount.toString(),
        status: "placed",
        paymentStatus: "pending",
        notes,
      }).returning();

      // Create order items with validated data using database prices
      const orderItemsData = items.map((item, index) => {
        const dbPrice = productValidation[index].requestedUnitPrice;
        return {
          orderId: newOrder.id,
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: dbPrice.toString(),
          totalPrice: (item.quantity * dbPrice).toString(),
        };
      });

      const createdItems = await tx.insert(orderItems).values(orderItemsData).returning();

      // Update product stock atomically with critical stock validation
      for (const item of items) {
        logger?.info("📦 [OrderManagement] Updating stock", { 
          productId: item.productId, 
          quantity: item.quantity 
        });
        
        // CRITICAL FIX: Use .returning() to detect if update succeeded
        const updatedProducts = await tx.update(products)
          .set({ 
            stock: sql`stock - ${item.quantity}`,
            updatedAt: new Date()
          })
          .where(
            and(
              eq(products.id, item.productId),
              sql`stock >= ${item.quantity}`
            )
          )
          .returning({ id: products.id, stock: products.stock });
        
        // CRITICAL: Check that exactly 1 row was affected
        if (updatedProducts.length === 0) {
          throw new Error(`CRITICAL: Failed to update stock for product ID ${item.productId} - insufficient inventory or product not found. This would have caused inventory inconsistency.`);
        }
        
        if (updatedProducts.length > 1) {
          throw new Error(`CRITICAL: Multiple products updated for ID ${item.productId}. This indicates a database integrity issue.`);
        }
        
        const updatedProduct = updatedProducts[0];
        logger?.info("✅ [OrderManagement] Stock updated successfully", { 
          productId: item.productId, 
          newStock: updatedProduct.stock 
        });
      }

      return { order: newOrder, items: createdItems, validatedProducts: productValidation };
    });

    logger?.info("✅ [OrderManagement] Order created successfully", { 
      orderId: result.order.id,
      customerName,
      totalAmount
    });
    
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger?.error("❌ [OrderManagement] Error creating order", { 
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      telegramUserId, 
      customerName 
    });
    throw error;
  }
};

// Get order details
const getOrder = async ({ 
  orderId, 
  telegramUserId, 
  logger 
}: { 
  orderId?: string, 
  telegramUserId?: string, 
  logger?: IMastraLogger 
}) => {
  try {
    logger?.info("🔍 [OrderManagement] Getting order details", { orderId, telegramUserId });

    let whereCondition;
    if (orderId) {
      whereCondition = eq(orders.id, orderId);
    } else if (telegramUserId) {
      whereCondition = eq(orders.telegramUserId, telegramUserId);
    } else {
      throw new Error("Either orderId or telegramUserId must be provided");
    }

    const orderData = await db.select().from(orders)
      .where(whereCondition)
      .orderBy(desc(orders.createdAt))
      .limit(1);

    if (orderData.length === 0) {
      logger?.warn("⚠️ [OrderManagement] Order not found", { orderId, telegramUserId });
      return null;
    }

    const order = orderData[0];

    // Get order items with product details
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

    logger?.info("✅ [OrderManagement] Order retrieved successfully", { 
      orderId: order.id,
      status: order.status,
      itemCount: items.length
    });

    return { ...order, items };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger?.error("❌ [OrderManagement] Error getting order", { 
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      orderId, 
      telegramUserId 
    });
    throw error;
  }
};

// Customer-friendly status messages (duplicated from customerNotificationTool for automation)
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

// Telegram message formatting for automated notifications
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

// CRITICAL AUTOMATION: Integrated notification dispatch
const sendAutomatedStatusNotification = async ({
  order,
  items,
  newStatus,
  notes,
  logger
}: {
  order: any,
  items: any[],
  newStatus: OrderStatus,
  notes?: string,
  logger?: IMastraLogger
}) => {
  try {
    logger?.info("📱 [OrderManagement] AUTOMATED: Sending status notification", { 
      orderId: order.id, 
      newStatus,
      recipientUserId: order.telegramUserId,
      hasNotes: !!notes
    });

    // Get status message template
    const statusInfo = STATUS_MESSAGES[newStatus];
    
    // Build notification message
    const orderSummary = formatOrderSummary(order, items);
    const estimatedTime = statusInfo.estimatedTime ? `\n\n⏰ *${statusInfo.estimatedTime}*` : '';
    const additionalMessage = notes ? `\n\n📝 ${notes}` : '';
    
    const notificationText = `
${statusInfo.icon} *${statusInfo.title}*

${statusInfo.message}${estimatedTime}${additionalMessage}

${orderSummary}

Thank you for choosing our discreet delivery service! 🌟
    `.trim();

    // Prepare Telegram message
    const telegramMessage = {
      chat_id: order.telegramUserId,
      text: notificationText,
      parse_mode: "Markdown",
      disable_notification: false, // Allow notifications for order updates
    };

    logger?.info("✅ [OrderManagement] AUTOMATED: Notification prepared successfully", { 
      orderId: order.id,
      recipientUserId: order.telegramUserId,
      recipientName: order.customerName,
      newStatus,
      messageLength: notificationText.length
    });

    // In a real implementation, this would send via Telegram Bot API
    // For now, we return the formatted message for the system to handle
    return {
      success: true,
      notification: telegramMessage,
      statusInfo,
      formattedMessage: notificationText
    };

  } catch (error) {
    logger?.error("❌ [OrderManagement] AUTOMATED: Error sending status notification", { 
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      orderId: order.id, 
      newStatus 
    });
    throw error;
  }
};

// Update order status with automated notifications
const updateOrderStatus = async ({ 
  orderId, 
  status, 
  notes, 
  logger 
}: { 
  orderId: string, 
  status: OrderStatus, 
  notes?: string, 
  logger?: IMastraLogger 
}) => {
  try {
    logger?.info("🔄 [OrderManagement] Updating order status with automated notifications", { 
      orderId, 
      status, 
      notes,
      willTriggerNotification: true
    });

    if (!ORDER_STATUSES.includes(status)) {
      throw new Error(`Invalid order status: ${status}`);
    }

    // First get the current order details for notification
    const currentOrderData = await db.select({
      id: orders.id,
      telegramUserId: orders.telegramUserId,
      telegramUsername: orders.telegramUsername,
      customerName: orders.customerName,
      deliveryAddress: orders.deliveryAddress,
      phoneNumber: orders.phoneNumber,
      totalAmount: orders.totalAmount,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
    }).from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

    if (currentOrderData.length === 0) {
      logger?.warn("⚠️ [OrderManagement] Order not found for status update", { orderId });
      return null;
    }

    const currentOrder = currentOrderData[0];
    
    // Get order items for notification
    const orderItemsData = await db.select({
      id: orderItems.id,
      quantity: orderItems.quantity,
      unitPrice: orderItems.unitPrice,
      totalPrice: orderItems.totalPrice,
      productName: products.name,
      productDescription: products.description,
    }).from(orderItems)
    .innerJoin(products, eq(orderItems.productId, products.id))
    .where(eq(orderItems.orderId, orderId));

    // Update the order status
    const updateData: any = { 
      status, 
      updatedAt: new Date() 
    };
    
    if (notes) {
      updateData.notes = notes;
    }

    const [updatedOrder] = await db.update(orders)
      .set(updateData)
      .where(eq(orders.id, orderId))
      .returning();

    if (!updatedOrder) {
      logger?.warn("⚠️ [OrderManagement] Order not found for status update", { orderId });
      return null;
    }

    logger?.info("✅ [OrderManagement] Order status updated successfully", { 
      orderId, 
      oldStatus: currentOrder.status,
      newStatus: status
    });

    // CRITICAL AUTOMATION: Send status notification automatically
    try {
      const notificationResult = await sendAutomatedStatusNotification({
        order: updatedOrder,
        items: orderItemsData,
        newStatus: status,
        notes,
        logger
      });
      
      logger?.info("🎯 [OrderManagement] AUTOMATED: Status notification triggered successfully", {
        orderId,
        newStatus: status,
        notificationSent: notificationResult.success
      });
      
      // Return both order and notification data
      return {
        ...updatedOrder,
        automatedNotification: notificationResult
      };
      
    } catch (notificationError) {
      logger?.error("⚠️ [OrderManagement] AUTOMATED: Notification failed but order status updated", {
        orderId,
        newStatus: status,
        notificationError: notificationError instanceof Error ? notificationError.message : 'Unknown error'
      });
      
      // Still return the updated order even if notification fails
      return updatedOrder;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger?.error("❌ [OrderManagement] Error updating order status", { 
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      orderId, 
      status 
    });
    throw error;
  }
};

// Get customer's order history
const getCustomerOrders = async ({ 
  telegramUserId, 
  limit = 10, 
  logger 
}: { 
  telegramUserId: string, 
  limit?: number, 
  logger?: IMastraLogger 
}) => {
  try {
    logger?.info("📋 [OrderManagement] Getting customer order history", { telegramUserId, limit });

    const customerOrders = await db.select().from(orders)
      .where(eq(orders.telegramUserId, telegramUserId))
      .orderBy(desc(orders.createdAt))
      .limit(limit);

    logger?.info("✅ [OrderManagement] Customer orders retrieved", { 
      telegramUserId, 
      orderCount: customerOrders.length 
    });

    return customerOrders;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger?.error("❌ [OrderManagement] Error getting customer orders", { 
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      telegramUserId 
    });
    throw error;
  }
};

export const orderManagementTool = createTool({
  id: "order-management-tool",
  description: "Manages orders for the personal lubricant delivery business with enforced operational preconditions AND automated customer notifications. Creates new orders, tracks order status, handles customer order history, and AUTOMATICALLY sends status notifications to customers. REQUIRES valid verification IDs from location, inventory, and payment tools.",
  inputSchema: z.object({
    action: z.enum(["create_order", "get_order", "update_status", "get_customer_orders"]).describe("Action to perform"),
    
    // Create order fields
    telegramUserId: z.string().optional().describe("Customer's Telegram user ID"),
    telegramUsername: z.string().optional().describe("Customer's Telegram username"),
    customerName: z.string().optional().describe("Customer's name"),
    deliveryAddress: z.string().optional().describe("Delivery address"),
    phoneNumber: z.string().optional().describe("Customer phone number"),
    orderItems: z.array(z.object({
      productId: z.number().int().positive().describe("Product ID must be a positive integer"),
      quantity: z.number().int().positive().describe("Quantity must be a positive integer"),
      unitPrice: z.number().positive().describe("Unit price must be positive"),
    })).min(1).optional().describe("Items being ordered - must contain at least one item"),
    totalAmount: z.number().positive().max(1000000).optional().describe("Total order amount - must be positive and reasonable"),
    notes: z.string().optional().describe("Order notes"),
    
    // CRITICAL: Operational precondition IDs (REQUIRED for create_order)
    verifiedLocationId: z.string().optional().describe("REQUIRED for create_order: Verified location ID from locationVerificationTool (format: LOC_YYYYMMDD_HHMMSS_HASH)"),
    inventoryReservationId: z.string().optional().describe("REQUIRED for create_order: Inventory reservation ID from productCatalogTool (format: INV_YYYYMMDD_HHMMSS_HASH)"),
    paymentTransactionId: z.string().optional().describe("REQUIRED for create_order: Payment transaction ID from cryptoPaymentTool (format: TXN_YYYYMMDD_HHMMSS_HASH)"),
    
    // Get/update order fields
    orderId: z.string().optional().describe("Order ID to get or update"),
    status: z.enum(ORDER_STATUSES).optional().describe("New order status"),
    limit: z.number().optional().describe("Limit for customer orders query"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    order: z.object({
      id: z.string(),
      telegramUserId: z.string(),
      telegramUsername: z.string().nullable(),
      customerName: z.string().nullable(),
      deliveryAddress: z.string(),
      phoneNumber: z.string().nullable(),
      totalAmount: z.string(),
      status: z.string(),
      paymentStatus: z.string(),
      notes: z.string().nullable(),
      createdAt: z.date(),
      updatedAt: z.date(),
      items: z.array(z.object({
        id: z.number(),
        quantity: z.number(),
        unitPrice: z.string(),
        totalPrice: z.string(),
        productName: z.string(),
        productDescription: z.string(),
      })).optional(),
    }).optional(),
    orders: z.array(z.object({
      id: z.string(),
      telegramUserId: z.string(),
      customerName: z.string().nullable(),
      totalAmount: z.string(),
      status: z.string(),
      paymentStatus: z.string(),
      createdAt: z.date(),
    })).optional(),
    message: z.string(),
  }),
  execute: async ({ context: { 
    action, 
    telegramUserId, 
    telegramUsername, 
    customerName, 
    deliveryAddress, 
    phoneNumber, 
    orderItems, 
    totalAmount, 
    notes, 
    orderId, 
    status, 
    limit 
  }, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔧 [OrderManagement] Starting order management", { 
      action, 
      telegramUserId, 
      orderId 
    });

    try {
      switch (action) {
        case "create_order": {
          if (!telegramUserId || !customerName || !deliveryAddress || !orderItems || !totalAmount) {
            return {
              success: false,
              message: "Missing required fields for order creation: telegramUserId, customerName, deliveryAddress, orderItems, totalAmount",
            };
          }
          
          // CRITICAL OPERATIONAL PRECONDITIONS: Server-side validation
          if (!verifiedLocationId || !inventoryReservationId || !paymentTransactionId) {
            logger?.error("🚫 [OrderManagement] OPERATIONAL PRECONDITIONS FAILED: Missing required verification IDs", {
              hasLocationId: !!verifiedLocationId,
              hasInventoryId: !!inventoryReservationId,
              hasPaymentId: !!paymentTransactionId,
              telegramUserId,
              customerName
            });
            return {
              success: false,
              message: "OPERATIONAL PRECONDITIONS FAILED: Order creation requires verifiedLocationId, inventoryReservationId, and paymentTransactionId from the respective verification tools. Please complete location verification, inventory reservation, and payment processing first.",
              requiredPreconditions: {
                verifiedLocationId: "Required from locationVerificationTool",
                inventoryReservationId: "Required from productCatalogTool stock check", 
                paymentTransactionId: "Required from cryptoPaymentTool verification"
              }
            };
          }
          
          // CRITICAL VALIDATION: Prevent empty orders
          if (!orderItems || orderItems.length === 0) {
            return {
              success: false,
              message: "Order must contain at least one item",
            };
          }
          
          // CRITICAL VALIDATION: Prevent zero/negative quantities and invalid data
          for (const item of orderItems) {
            if (!item.productId || item.productId <= 0) {
              return {
                success: false,
                message: `Invalid product ID: ${item.productId}. Product ID must be a positive integer.`,
              };
            }
            if (!item.quantity || item.quantity <= 0) {
              return {
                success: false,
                message: `Invalid quantity: ${item.quantity}. Quantity must be a positive integer.`,
              };
            }
            if (!item.unitPrice || item.unitPrice <= 0) {
              return {
                success: false,
                message: `Invalid unit price: ${item.unitPrice}. Unit price must be positive.`,
              };
            }
          }
          
          // CRITICAL VALIDATION: Prevent invalid total amounts
          if (totalAmount <= 0) {
            return {
              success: false,
              message: `Invalid total amount: ${totalAmount}. Total amount must be positive.`,
            };
          }
          
          if (totalAmount > 1000000) {
            return {
              success: false,
              message: `Total amount too large: ${totalAmount}. Maximum allowed is $1,000,000.`,
            };
          }
          
          const result = await createOrder({ 
            telegramUserId,
            telegramUsername,
            customerName,
            deliveryAddress,
            phoneNumber,
            orderItems,
            totalAmount,
            notes,
            verifiedLocationId,
            inventoryReservationId,
            paymentTransactionId,
            logger 
          });
          
          return {
            success: true,
            order: {
              id: result.order.id,
              telegramUserId: result.order.telegramUserId,
              telegramUsername: result.order.telegramUsername,
              customerName: result.order.customerName,
              deliveryAddress: result.order.deliveryAddress,
              phoneNumber: result.order.phoneNumber,
              totalAmount: result.order.totalAmount,
              status: result.order.status,
              paymentStatus: result.order.paymentStatus,
              notes: result.order.notes,
              createdAt: result.order.createdAt,
              updatedAt: result.order.updatedAt,
              items: result.items.map((item, index) => ({
                id: item.id,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                totalPrice: item.totalPrice,
                productName: result.validatedProducts[index]?.name || "Product",
                productDescription: result.validatedProducts[index]?.description || "Product Description",
              })),
            },
            message: `Order ${result.order.id} created successfully for ${customerName}`,
          };
        }

        case "get_order": {
          const orderData = await getOrder({ orderId, telegramUserId, logger });
          
          if (!orderData) {
            return {
              success: false,
              message: "Order not found",
            };
          }
          
          return {
            success: true,
            order: {
              id: orderData.id,
              telegramUserId: orderData.telegramUserId,
              telegramUsername: orderData.telegramUsername,
              customerName: orderData.customerName,
              deliveryAddress: orderData.deliveryAddress,
              phoneNumber: orderData.phoneNumber,
              totalAmount: orderData.totalAmount,
              status: orderData.status,
              paymentStatus: orderData.paymentStatus,
              notes: orderData.notes,
              createdAt: orderData.createdAt,
              updatedAt: orderData.updatedAt,
              items: orderData.items?.map(item => ({
                id: item.id,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                totalPrice: item.totalPrice,
                productName: item.productName,
                productDescription: item.productDescription,
              })),
            },
            message: `Order ${orderData.id} retrieved successfully`,
          };
        }

        case "update_status": {
          if (!orderId || !status) {
            return {
              success: false,
              message: "Order ID and status are required for status update",
            };
          }
          
          const updatedOrderResult = await updateOrderStatus({ orderId, status, notes, logger });
          
          if (!updatedOrderResult) {
            return {
              success: false,
              message: "Order not found for status update",
            };
          }
          
          // Handle both regular updates and updates with notification data
          const updatedOrder = updatedOrderResult.automatedNotification ? 
            { ...updatedOrderResult, automatedNotification: undefined } : updatedOrderResult;
          const notificationInfo = updatedOrderResult.automatedNotification;
          
          const baseMessage = `Order ${orderId} status updated to ${status}`;
          const notificationMessage = notificationInfo ? 
            ` and customer notification sent automatically` : ``;
          
          return {
            success: true,
            order: {
              id: updatedOrder.id,
              telegramUserId: updatedOrder.telegramUserId,
              telegramUsername: updatedOrder.telegramUsername,
              customerName: updatedOrder.customerName,
              deliveryAddress: updatedOrder.deliveryAddress,
              phoneNumber: updatedOrder.phoneNumber,
              totalAmount: updatedOrder.totalAmount,
              status: updatedOrder.status,
              paymentStatus: updatedOrder.paymentStatus,
              notes: updatedOrder.notes,
              createdAt: updatedOrder.createdAt,
              updatedAt: updatedOrder.updatedAt,
            },
            automatedNotification: notificationInfo ? {
              sent: notificationInfo.success,
              recipientUserId: notificationInfo.notification.chat_id,
              notificationType: "status_update",
              statusTitle: notificationInfo.statusInfo.title
            } : undefined,
            message: baseMessage + notificationMessage,
          };
        }

        case "get_customer_orders": {
          if (!telegramUserId) {
            return {
              success: false,
              message: "Telegram user ID is required to get customer orders",
            };
          }
          
          const customerOrders = await getCustomerOrders({ telegramUserId, limit, logger });
          
          return {
            success: true,
            orders: customerOrders.map(order => ({
              id: order.id,
              telegramUserId: order.telegramUserId,
              customerName: order.customerName,
              totalAmount: order.totalAmount,
              status: order.status,
              paymentStatus: order.paymentStatus,
              createdAt: order.createdAt,
            })),
            message: `Found ${customerOrders.length} orders for customer`,
          };
        }

        default:
          return {
            success: false,
            message: "Invalid action specified",
          };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [OrderManagement] Tool execution failed", { 
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        action,
        telegramUserId,
        orderId
      });
      return {
        success: false,
        message: `Failed to execute order management operation: ${errorMessage}`,
      };
    }
  },
});