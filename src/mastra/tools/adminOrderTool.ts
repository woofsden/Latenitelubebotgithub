import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";
import { db } from "../../../server/storage";
import { orders, orderItems, products } from "../../../shared/schema";
import { eq, and, desc, gte, lte, like, inArray, sql } from "drizzle-orm";

// Order status values with admin-specific workflow rules
const ORDER_STATUSES = [
  "placed",        // Order has been placed
  "received",      // Order received by business
  "in_progress",   // Order being prepared
  "out_for_delivery", // Order is out for delivery
  "delivered",     // Order has been delivered
  "cancelled"      // Order cancelled
] as const;

type OrderStatus = typeof ORDER_STATUSES[number];

// Valid status transitions for admin workflow
const VALID_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  "placed": ["received", "cancelled"],
  "received": ["in_progress", "cancelled"],
  "in_progress": ["out_for_delivery", "cancelled"],
  "out_for_delivery": ["delivered", "cancelled"],
  "delivered": [], // Final state - no further transitions
  "cancelled": []  // Final state - no further transitions
};

// Get all orders with filtering for admin dashboard
const getAdminOrderList = async ({ 
  status,
  dateFrom,
  dateTo,
  customerSearch,
  limit = 50,
  offset = 0,
  logger 
}: { 
  status?: OrderStatus,
  dateFrom?: string,
  dateTo?: string,
  customerSearch?: string,
  limit?: number,
  offset?: number,
  logger?: IMastraLogger 
}) => {
  try {
    logger?.info("📋 [AdminOrderTool] Getting admin order list", { 
      status, 
      dateFrom, 
      dateTo, 
      customerSearch,
      limit,
      offset
    });

    // Build where conditions dynamically
    const whereConditions = [];
    
    if (status) {
      whereConditions.push(eq(orders.status, status));
    }
    
    if (dateFrom) {
      whereConditions.push(gte(orders.createdAt, new Date(dateFrom)));
    }
    
    if (dateTo) {
      whereConditions.push(lte(orders.createdAt, new Date(dateTo)));
    }
    
    if (customerSearch) {
      whereConditions.push(
        like(orders.customerName, `%${customerSearch}%`)
      );
    }

    const whereClause = whereConditions.length > 0 ? and(...whereConditions) : undefined;

    // Get orders with item count
    const ordersList = await db.select({
      id: orders.id,
      telegramUserId: orders.telegramUserId,
      telegramUsername: orders.telegramUsername,
      customerName: orders.customerName,
      deliveryAddress: orders.deliveryAddress,
      phoneNumber: orders.phoneNumber,
      totalAmount: orders.totalAmount,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      notes: orders.notes,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
    }).from(orders)
    .where(whereClause)
    .orderBy(desc(orders.createdAt))
    .limit(limit)
    .offset(offset);

    // Get item counts for each order
    const orderIds = ordersList.map(order => order.id);
    const itemCounts = orderIds.length > 0 ? await db.select({
      orderId: orderItems.orderId,
      itemCount: sql<number>`count(*)::int`,
      totalItems: sql<number>`sum(${orderItems.quantity})::int`,
    }).from(orderItems)
    .where(inArray(orderItems.orderId, orderIds))
    .groupBy(orderItems.orderId) : [];

    // Combine orders with item counts
    const ordersWithCounts = ordersList.map(order => {
      const count = itemCounts.find(c => c.orderId === order.id);
      return {
        ...order,
        itemCount: count?.itemCount || 0,
        totalItems: count?.totalItems || 0,
      };
    });

    logger?.info("✅ [AdminOrderTool] Admin order list retrieved", { 
      orderCount: ordersWithCounts.length,
      filters: { status, dateFrom, dateTo, customerSearch }
    });

    return ordersWithCounts;
  } catch (error) {
    logger?.error("❌ [AdminOrderTool] Error getting admin order list", { 
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      status, dateFrom, dateTo, customerSearch 
    });
    throw error;
  }
};

// Get detailed order information for admin
const getAdminOrderDetails = async ({ 
  orderId, 
  logger 
}: { 
  orderId: string, 
  logger?: IMastraLogger 
}) => {
  try {
    logger?.info("🔍 [AdminOrderTool] Getting admin order details", { orderId });

    const orderData = await db.select().from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (orderData.length === 0) {
      logger?.warn("⚠️ [AdminOrderTool] Order not found", { orderId });
      return null;
    }

    const order = orderData[0];

    // Get order items with product details
    const items = await db.select({
      id: orderItems.id,
      quantity: orderItems.quantity,
      unitPrice: orderItems.unitPrice,
      totalPrice: orderItems.totalPrice,
      productId: products.id,
      productName: products.name,
      productDescription: products.description,
      productPrice: products.price,
      productStock: products.stock,
    }).from(orderItems)
    .innerJoin(products, eq(orderItems.productId, products.id))
    .where(eq(orderItems.orderId, order.id));

    // Get valid next statuses for admin
    const validNextStatuses = VALID_STATUS_TRANSITIONS[order.status as OrderStatus] || [];

    logger?.info("✅ [AdminOrderTool] Admin order details retrieved", { 
      orderId: order.id,
      status: order.status,
      itemCount: items.length,
      validNextStatuses
    });

    return { 
      ...order, 
      items,
      validNextStatuses,
      canUpdate: validNextStatuses.length > 0
    };
  } catch (error) {
    logger?.error("❌ [AdminOrderTool] Error getting admin order details", { 
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      orderId 
    });
    throw error;
  }
};

// Update order status with admin validation
const updateOrderStatusAdmin = async ({ 
  orderId, 
  newStatus, 
  adminNotes, 
  adminUserId,
  logger 
}: { 
  orderId: string, 
  newStatus: OrderStatus, 
  adminNotes?: string,
  adminUserId?: string,
  logger?: IMastraLogger 
}) => {
  try {
    logger?.info("🔄 [AdminOrderTool] Admin updating order status", { 
      orderId, 
      newStatus, 
      adminUserId,
      hasNotes: !!adminNotes
    });

    // Get current order status and existing notes
    const [currentOrder] = await db.select({ 
      status: orders.status,
      customerName: orders.customerName,
      notes: orders.notes
    }).from(orders)
    .where(eq(orders.id, orderId));

    if (!currentOrder) {
      throw new Error(`Order ${orderId} not found`);
    }

    const currentStatus = currentOrder.status as OrderStatus;
    const validTransitions = VALID_STATUS_TRANSITIONS[currentStatus];

    // Validate status transition
    if (!validTransitions.includes(newStatus)) {
      throw new Error(`Invalid status transition from '${currentStatus}' to '${newStatus}'. Valid transitions: ${validTransitions.join(', ')}`);
    }

    // Preserve existing notes and prepend admin notes with metadata
    const existingNotes = currentOrder.notes || '';
    let newAdminLog = '';
    
    if (adminUserId) {
      const timestamp = new Date().toISOString();
      newAdminLog = `[${timestamp}] Admin ${adminUserId}: Status changed from '${currentStatus}' to '${newStatus}'`;
      if (adminNotes) {
        newAdminLog += `\nAdmin notes: ${adminNotes}`;
      }
    } else if (adminNotes) {
      // If no adminUserId but we have admin notes, still log them with timestamp
      const timestamp = new Date().toISOString();
      newAdminLog = `[${timestamp}] Admin notes: ${adminNotes}`;
    }
    
    // Combine: new admin log + existing notes (preserve all historical data)
    const finalNotes = newAdminLog 
      ? existingNotes 
        ? `${newAdminLog}\n${existingNotes}` 
        : newAdminLog
      : existingNotes;

    // Update order status
    const [updatedOrder] = await db.update(orders)
      .set({ 
        status: newStatus, 
        notes: finalNotes,
        updatedAt: new Date() 
      })
      .where(eq(orders.id, orderId))
      .returning();

    logger?.info("✅ [AdminOrderTool] Order status updated successfully", { 
      orderId, 
      previousStatus: currentStatus,
      newStatus,
      customerName: currentOrder.customerName,
      adminUserId
    });

    return {
      ...updatedOrder,
      previousStatus: currentStatus,
      statusTransition: `${currentStatus} → ${newStatus}`
    };
  } catch (error) {
    logger?.error("❌ [AdminOrderTool] Error updating order status", { 
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      orderId, newStatus, adminUserId 
    });
    throw error;
  }
};

// Bulk update order status for multiple orders
const bulkUpdateOrderStatus = async ({ 
  orderIds, 
  newStatus, 
  adminNotes, 
  adminUserId,
  logger 
}: { 
  orderIds: string[], 
  newStatus: OrderStatus, 
  adminNotes?: string,
  adminUserId?: string,
  logger?: IMastraLogger 
}) => {
  try {
    logger?.info("📦 [AdminOrderTool] Bulk updating order statuses", { 
      orderCount: orderIds.length,
      newStatus, 
      adminUserId,
      hasNotes: !!adminNotes
    });

    const results = [];
    const errors = [];

    // Process each order individually to maintain validation
    for (const orderId of orderIds) {
      try {
        const result = await updateOrderStatusAdmin({ 
          orderId, 
          newStatus, 
          adminNotes, 
          adminUserId, 
          logger 
        });
        results.push({ orderId, success: true, result });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        errors.push({ orderId, success: false, error: errorMessage });
        logger?.warn("⚠️ [AdminOrderTool] Failed to update order in bulk", { 
          orderId, 
          error: errorMessage 
        });
      }
    }

    logger?.info("✅ [AdminOrderTool] Bulk update completed", { 
      totalOrders: orderIds.length,
      successful: results.length,
      failed: errors.length,
      newStatus,
      adminUserId
    });

    return {
      successful: results,
      failed: errors,
      summary: {
        total: orderIds.length,
        successCount: results.length,
        failureCount: errors.length,
      }
    };
  } catch (error) {
    logger?.error("❌ [AdminOrderTool] Error in bulk update", { 
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      orderIds, newStatus, adminUserId 
    });
    throw error;
  }
};

// Get order statistics for admin dashboard
const getOrderStatistics = async ({ 
  dateFrom,
  dateTo,
  logger 
}: { 
  dateFrom?: string,
  dateTo?: string,
  logger?: IMastraLogger 
}) => {
  try {
    logger?.info("📊 [AdminOrderTool] Getting order statistics", { dateFrom, dateTo });

    // Build date filter
    const whereConditions = [];
    if (dateFrom) {
      whereConditions.push(gte(orders.createdAt, new Date(dateFrom)));
    }
    if (dateTo) {
      whereConditions.push(lte(orders.createdAt, new Date(dateTo)));
    }
    const whereClause = whereConditions.length > 0 ? and(...whereConditions) : undefined;

    // Get status counts
    const statusCounts = await db.select({
      status: orders.status,
      count: sql<number>`count(*)::int`,
      totalValue: sql<string>`sum(CAST(${orders.totalAmount} AS DECIMAL))::text`,
    }).from(orders)
    .where(whereClause)
    .groupBy(orders.status);

    // Get payment status counts
    const paymentCounts = await db.select({
      paymentStatus: orders.paymentStatus,
      count: sql<number>`count(*)::int`,
    }).from(orders)
    .where(whereClause)
    .groupBy(orders.paymentStatus);

    // Get total metrics
    const [totalMetrics] = await db.select({
      totalOrders: sql<number>`count(*)::int`,
      totalRevenue: sql<string>`sum(CAST(${orders.totalAmount} AS DECIMAL))::text`,
      averageOrderValue: sql<string>`avg(CAST(${orders.totalAmount} AS DECIMAL))::text`,
    }).from(orders)
    .where(whereClause);

    logger?.info("✅ [AdminOrderTool] Order statistics retrieved", { 
      totalOrders: totalMetrics?.totalOrders || 0,
      statusBreakdown: statusCounts.length,
      dateRange: { dateFrom, dateTo }
    });

    return {
      statusBreakdown: statusCounts,
      paymentBreakdown: paymentCounts,
      totalMetrics: totalMetrics || { totalOrders: 0, totalRevenue: '0', averageOrderValue: '0' },
      dateRange: { dateFrom, dateTo }
    };
  } catch (error) {
    logger?.error("❌ [AdminOrderTool] Error getting order statistics", { 
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      dateFrom, dateTo 
    });
    throw error;
  }
};

export const adminOrderTool = createTool({
  id: "admin-order-tool",
  description: "Comprehensive admin tools for managing orders in the personal lubricant delivery business. Provides order listing, status updates, bulk operations, and dashboard statistics.",
  inputSchema: z.object({
    action: z.enum([
      "list_orders", 
      "get_order_details", 
      "update_status", 
      "bulk_update_status", 
      "get_statistics"
    ]).describe("Admin action to perform"),
    
    // List orders parameters
    status: z.enum(ORDER_STATUSES).optional().describe("Filter orders by status"),
    dateFrom: z.string().optional().describe("Filter orders from date (ISO string)"),
    dateTo: z.string().optional().describe("Filter orders to date (ISO string)"),
    customerSearch: z.string().optional().describe("Search orders by customer name"),
    limit: z.number().int().positive().max(200).default(50).describe("Maximum number of orders to return"),
    offset: z.number().int().min(0).default(0).describe("Number of orders to skip for pagination"),
    
    // Order details parameters
    orderId: z.string().optional().describe("Order ID to get details or update"),
    
    // Status update parameters
    newStatus: z.enum(ORDER_STATUSES).optional().describe("New status to set for order(s)"),
    adminNotes: z.string().optional().describe("Admin notes to add with status update"),
    adminUserId: z.string().optional().describe("ID of admin user making the update"),
    
    // Bulk update parameters
    orderIds: z.array(z.string()).optional().describe("Array of order IDs for bulk operations"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    action: z.string(),
    
    // List orders response
    orders: z.array(z.object({
      id: z.string(),
      telegramUserId: z.string(),
      telegramUsername: z.string().nullable(),
      customerName: z.string().nullable(),
      deliveryAddress: z.string(),
      totalAmount: z.string(),
      status: z.string(),
      paymentStatus: z.string(),
      createdAt: z.date(),
      updatedAt: z.date(),
      itemCount: z.number(),
      totalItems: z.number(),
    })).optional(),
    
    // Order details response
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
        productId: z.number(),
        productName: z.string(),
        productDescription: z.string(),
        productPrice: z.string(),
        productStock: z.number(),
      })),
      validNextStatuses: z.array(z.string()),
      canUpdate: z.boolean(),
      previousStatus: z.string().optional(),
      statusTransition: z.string().optional(),
    }).optional(),
    
    // Bulk update response
    bulkResult: z.object({
      successful: z.array(z.object({
        orderId: z.string(),
        success: z.boolean(),
        result: z.any(),
      })),
      failed: z.array(z.object({
        orderId: z.string(),
        success: z.boolean(),
        error: z.string(),
      })),
      summary: z.object({
        total: z.number(),
        successCount: z.number(),
        failureCount: z.number(),
      }),
    }).optional(),
    
    // Statistics response
    statistics: z.object({
      statusBreakdown: z.array(z.object({
        status: z.string(),
        count: z.number(),
        totalValue: z.string(),
      })),
      paymentBreakdown: z.array(z.object({
        paymentStatus: z.string(),
        count: z.number(),
      })),
      totalMetrics: z.object({
        totalOrders: z.number(),
        totalRevenue: z.string(),
        averageOrderValue: z.string(),
      }),
      dateRange: z.object({
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
      }),
    }).optional(),
    
    message: z.string(),
  }),
  execute: async ({ context: { 
    action,
    status,
    dateFrom,
    dateTo,
    customerSearch,
    limit,
    offset,
    orderId,
    newStatus,
    adminNotes,
    adminUserId,
    orderIds
  }, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔧 [AdminOrderTool] Starting admin order management", { 
      action, 
      orderId,
      newStatus,
      adminUserId
    });

    try {
      switch (action) {
        case "list_orders": {
          const orders = await getAdminOrderList({ 
            status, 
            dateFrom, 
            dateTo, 
            customerSearch, 
            limit, 
            offset, 
            logger 
          });
          
          return {
            success: true,
            action,
            orders,
            message: `Found ${orders.length} orders matching criteria`,
          };
        }

        case "get_order_details": {
          if (!orderId) {
            return {
              success: false,
              action,
              message: "Order ID is required for getting order details",
            };
          }
          
          const order = await getAdminOrderDetails({ orderId, logger });
          
          if (!order) {
            return {
              success: false,
              action,
              message: "Order not found",
            };
          }
          
          return {
            success: true,
            action,
            order,
            message: `Order ${orderId} details retrieved successfully`,
          };
        }

        case "update_status": {
          if (!orderId || !newStatus) {
            return {
              success: false,
              action,
              message: "Order ID and new status are required for status update",
            };
          }
          
          const updatedOrder = await updateOrderStatusAdmin({ 
            orderId, 
            newStatus, 
            adminNotes, 
            adminUserId, 
            logger 
          });
          
          return {
            success: true,
            action,
            order: {
              ...updatedOrder,
              items: [], // Not returned in status update
              validNextStatuses: VALID_STATUS_TRANSITIONS[newStatus],
              canUpdate: VALID_STATUS_TRANSITIONS[newStatus].length > 0,
            },
            message: `Order ${orderId} status updated to ${newStatus}`,
          };
        }

        case "bulk_update_status": {
          if (!orderIds || orderIds.length === 0 || !newStatus) {
            return {
              success: false,
              action,
              message: "Order IDs array and new status are required for bulk update",
            };
          }
          
          const bulkResult = await bulkUpdateOrderStatus({ 
            orderIds, 
            newStatus, 
            adminNotes, 
            adminUserId, 
            logger 
          });
          
          return {
            success: true,
            action,
            bulkResult,
            message: `Bulk update completed: ${bulkResult.summary.successCount} successful, ${bulkResult.summary.failureCount} failed`,
          };
        }

        case "get_statistics": {
          const statistics = await getOrderStatistics({ dateFrom, dateTo, logger });
          
          return {
            success: true,
            action,
            statistics,
            message: `Order statistics retrieved for ${statistics.totalMetrics.totalOrders} orders`,
          };
        }

        default:
          return {
            success: false,
            action: action || "unknown",
            message: "Invalid action specified",
          };
      }
    } catch (error) {
      logger?.error("❌ [AdminOrderTool] Tool execution failed", { 
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        action,
        orderId,
        newStatus
      });
      return {
        success: false,
        action: action || "unknown",
        message: `Failed to execute admin order operation: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
});