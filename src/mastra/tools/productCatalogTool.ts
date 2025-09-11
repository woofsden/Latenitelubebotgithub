import { createTool } from "@mastra/core/tools";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";
import { db } from "../../../server/storage";
import { products } from "../../../shared/schema";
import { eq, and } from "drizzle-orm";

// Get all available products
const getProducts = async ({ logger }: { logger?: IMastraLogger }) => {
  try {
    logger?.info("🛍️ [ProductCatalog] Fetching all active products");
    const activeProducts = await db.select().from(products).where(eq(products.isActive, true));
    logger?.info("✅ [ProductCatalog] Retrieved products", { count: activeProducts.length });
    return activeProducts;
  } catch (error) {
    logger?.error("❌ [ProductCatalog] Error fetching products", { error });
    throw error;
  }
};

// Check product availability and stock
const checkProductStock = async ({ productId, logger }: { productId: number, logger?: IMastraLogger }) => {
  try {
    logger?.info("📦 [ProductCatalog] Checking stock for product", { productId });
    const product = await db.select().from(products).where(
      and(eq(products.id, productId), eq(products.isActive, true))
    ).limit(1);
    
    if (product.length === 0) {
      logger?.warn("⚠️ [ProductCatalog] Product not found or inactive", { productId });
      return null;
    }
    
    logger?.info("✅ [ProductCatalog] Product stock checked", { 
      productId, 
      name: product[0].name, 
      stock: product[0].stock 
    });
    return product[0];
  } catch (error) {
    logger?.error("❌ [ProductCatalog] Error checking product stock", { productId, error });
    throw error;
  }
};

// Update product stock (for inventory management)
const updateProductStock = async ({ 
  productId, 
  newStock, 
  logger 
}: { 
  productId: number, 
  newStock: number, 
  logger?: IMastraLogger 
}) => {
  try {
    logger?.info("🔄 [ProductCatalog] Updating product stock", { productId, newStock });
    const updated = await db.update(products)
      .set({ 
        stock: newStock, 
        updatedAt: new Date() 
      })
      .where(eq(products.id, productId))
      .returning();
    
    if (updated.length === 0) {
      logger?.warn("⚠️ [ProductCatalog] Product not found for stock update", { productId });
      return null;
    }
    
    logger?.info("✅ [ProductCatalog] Product stock updated successfully", { 
      productId, 
      newStock,
      productName: updated[0].name
    });
    return updated[0];
  } catch (error) {
    logger?.error("❌ [ProductCatalog] Error updating product stock", { productId, newStock, error });
    throw error;
  }
};

export const productCatalogTool = createTool({
  id: "product-catalog-tool",
  description: "Manages the product catalog for the personal lubricant delivery business. Shows available products with prices, descriptions, and stock levels to customers.",
  inputSchema: z.object({
    action: z.enum(["list_products", "check_stock", "update_stock"]).describe("Action to perform"),
    productId: z.number().optional().describe("Product ID for stock operations"),
    newStock: z.number().optional().describe("New stock level (for update_stock action)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    products: z.array(z.object({
      id: z.number(),
      name: z.string(),
      description: z.string(),
      price: z.string(),
      stock: z.number(),
      isActive: z.boolean(),
    })).optional(),
    product: z.object({
      id: z.number(),
      name: z.string(),
      description: z.string(),
      price: z.string(),
      stock: z.number(),
      isActive: z.boolean(),
    }).optional(),
    message: z.string(),
  }),
  execute: async ({ context: { action, productId, newStock }, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔧 [ProductCatalog] Starting execution", { action, productId, newStock });

    try {
      switch (action) {
        case "list_products": {
          const productList = await getProducts({ logger });
          return {
            success: true,
            products: productList.map(p => ({
              id: p.id,
              name: p.name,
              description: p.description,
              price: p.price,
              stock: p.stock,
              isActive: p.isActive,
            })),
            message: `Found ${productList.length} available products`,
          };
        }

        case "check_stock": {
          if (!productId) {
            return {
              success: false,
              message: "Product ID is required for stock check",
            };
          }
          
          const product = await checkProductStock({ productId, logger });
          if (!product) {
            return {
              success: false,
              message: "Product not found or inactive",
            };
          }
          
          return {
            success: true,
            product: {
              id: product.id,
              name: product.name,
              description: product.description,
              price: product.price,
              stock: product.stock,
              isActive: product.isActive,
            },
            message: `Product "${product.name}" has ${product.stock} units in stock`,
          };
        }

        case "update_stock": {
          if (!productId || newStock === undefined) {
            return {
              success: false,
              message: "Product ID and new stock level are required for stock update",
            };
          }
          
          const updatedProduct = await updateProductStock({ productId, newStock, logger });
          if (!updatedProduct) {
            return {
              success: false,
              message: "Product not found for stock update",
            };
          }
          
          return {
            success: true,
            product: {
              id: updatedProduct.id,
              name: updatedProduct.name,
              description: updatedProduct.description,
              price: updatedProduct.price,
              stock: updatedProduct.stock,
              isActive: updatedProduct.isActive,
            },
            message: `Stock updated for "${updatedProduct.name}" to ${newStock} units`,
          };
        }

        default:
          return {
            success: false,
            message: "Invalid action specified",
          };
      }
    } catch (error) {
      logger?.error("❌ [ProductCatalog] Tool execution failed", { error });
      return {
        success: false,
        message: "Failed to execute product catalog operation",
      };
    }
  },
});