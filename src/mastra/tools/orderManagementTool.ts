import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";
import { db } from "../../../server/storage";
import { orders, orderItems, products } from "../../../shared/schema";
import { eq, and, desc, sql } from "drizzle-orm";

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

// Create a new order
const createOrder = async ({ 
  telegramUserId,
  telegramUsername,
  customerName,
  deliveryAddress,
  phoneNumber,
  orderItems: items,
  totalAmount,
  notes,
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
  logger?: IMastraLogger 
}) => {
  try {
    logger?.info("📦 [OrderManagement] Creating new order", { 
      telegramUserId, 
      customerName, 
      totalAmount,
      itemCount: items.length 
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

// Update order status
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
    logger?.info("🔄 [OrderManagement] Updating order status", { orderId, status, notes });

    if (!ORDER_STATUSES.includes(status)) {
      throw new Error(`Invalid order status: ${status}`);
    }

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
      newStatus: status
    });

    return updatedOrder;
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
  description: "Manages orders for the personal lubricant delivery business. Creates new orders, tracks order status, and handles customer order history.",
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
          
          const updatedOrder = await updateOrderStatus({ orderId, status, notes, logger });
          
          if (!updatedOrder) {
            return {
              success: false,
              message: "Order not found for status update",
            };
          }
          
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
            message: `Order ${orderId} status updated to ${status}`,
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