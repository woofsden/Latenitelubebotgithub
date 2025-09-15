import { validateCredentials, createSession, requireAuth } from './auth';
import { sharedPostgresStorage } from '../../mastra/storage';
import { sql } from 'drizzle-orm';

export const adminRoutes = {
  // Authentication endpoint
  login: async (req: any, res: any) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({
          success: false,
          message: 'Username and password required'
        });
      }

      if (!validateCredentials(username, password)) {
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials'
        });
      }

      const token = createSession(username);

      res.json({
        success: true,
        token,
        message: 'Login successful'
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  },

  // Dashboard stats
  getStats: async (req: any, res: any) => {
    try {
      if (!requireAuth(req)) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      // Use the shared storage to get stats
      const db = sharedPostgresStorage.db;
      
      // Simple queries to get stats
      const [orderCount, pendingOrders, revenue, productCount] = await Promise.all([
        db.execute(sql`SELECT COUNT(*) as total_orders FROM orders`),
        db.execute(sql`SELECT COUNT(*) as pending_orders FROM orders WHERE status NOT IN ('delivered', 'cancelled')`),
        db.execute(sql`SELECT COALESCE(SUM(total_amount), 0) as revenue FROM orders`),
        db.execute(sql`SELECT COUNT(*) as active_products FROM products WHERE is_active = true`)
      ]);

      const stats = {
        totalOrders: parseInt((orderCount as any)[0]?.total_orders || '0'),
        pendingOrders: parseInt((pendingOrders as any)[0]?.pending_orders || '0'),
        revenue: parseFloat((revenue as any)[0]?.revenue || '0'),
        activeProducts: parseInt((productCount as any)[0]?.active_products || '0')
      };

      res.json(stats);
    } catch (error) {
      console.error('Stats error:', error);
      res.status(500).json({ success: false, message: 'Failed to load stats' });
    }
  },

  // Get all orders
  getOrders: async (req: any, res: any) => {
    try {
      if (!requireAuth(req)) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const db = sharedPostgresStorage.db;
      const orders = await db.execute(sql`
        SELECT 
          o.*,
          json_agg(
            json_build_object(
              'product_name', p.name,
              'quantity', oi.quantity,
              'price', oi.price
            )
          ) as items
        FROM orders o
        LEFT JOIN order_items oi ON o.id = oi.order_id
        LEFT JOIN products p ON oi.product_id = p.id
        GROUP BY o.id
        ORDER BY o.created_at DESC
      `);

      res.json({ orders });
    } catch (error) {
      console.error('Orders error:', error);
      res.status(500).json({ success: false, message: 'Failed to load orders' });
    }
  },

  // Update order status
  updateOrderStatus: async (req: any, res: any) => {
    try {
      if (!requireAuth(req)) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const { orderId, status } = req.body;

      if (!orderId || !status) {
        return res.status(400).json({
          success: false,
          message: 'Order ID and status required'
        });
      }

      const validStatuses = ['placed', 'received', 'in_progress', 'out_for_delivery', 'delivered', 'cancelled'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid status'
        });
      }

      const db = sharedPostgresStorage.db;
      await db.execute(sql`
        UPDATE orders 
        SET status = ${status}, updated_at = NOW()
        WHERE id = ${orderId}
      `);

      res.json({
        success: true,
        message: 'Order status updated successfully'
      });
    } catch (error) {
      console.error('Update order status error:', error);
      res.status(500).json({ success: false, message: 'Failed to update order status' });
    }
  },

  // Get all products
  getProducts: async (req: any, res: any) => {
    try {
      if (!requireAuth(req)) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const db = sharedPostgresStorage.db;
      const products = await db.execute(sql`SELECT * FROM products ORDER BY name`);

      res.json({ products });
    } catch (error) {
      console.error('Products error:', error);
      res.status(500).json({ success: false, message: 'Failed to load products' });
    }
  },

  // Update product stock
  updateProductStock: async (req: any, res: any) => {
    try {
      if (!requireAuth(req)) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const { productId, stock } = req.body;

      if (!productId || stock === undefined || stock < 0) {
        return res.status(400).json({
          success: false,
          message: 'Product ID and valid stock quantity required'
        });
      }

      const db = sharedPostgresStorage.db;
      await db.execute(sql`
        UPDATE products 
        SET stock = ${stock}, updated_at = NOW()
        WHERE id = ${productId}
      `);

      res.json({
        success: true,
        message: 'Product stock updated successfully'
      });
    } catch (error) {
      console.error('Update product stock error:', error);
      res.status(500).json({ success: false, message: 'Failed to update product stock' });
    }
  },

  // Send notification
  sendNotification: async (req: any, res: any) => {
    try {
      if (!requireAuth(req)) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const { customer, type, message } = req.body;

      if (!customer || !type || !message) {
        return res.status(400).json({
          success: false,
          message: 'Customer, type, and message are required'
        });
      }

      // Send notification via Telegram
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (!botToken) {
        return res.status(500).json({
          success: false,
          message: 'Telegram bot not configured'
        });
      }

      const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const messagePayload = {
        chat_id: customer,
        text: `📱 **${type.replace('_', ' ').toUpperCase()}**\n\n${message}`,
        parse_mode: 'Markdown'
      };

      const response = await fetch(telegramApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messagePayload),
      });

      const result = await response.json();

      if (!response.ok || !result.ok) {
        return res.status(400).json({
          success: false,
          message: result.description || 'Failed to send notification'
        });
      }

      res.json({
        success: true,
        message: 'Notification sent successfully'
      });
    } catch (error) {
      console.error('Send notification error:', error);
      res.status(500).json({ success: false, message: 'Failed to send notification' });
    }
  }
};