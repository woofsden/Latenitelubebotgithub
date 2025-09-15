class AdminDashboard {
    constructor() {
        this.isAuthenticated = false;
        this.currentSection = 'orders';
        this.orders = [];
        this.products = [];
        this.init();
    }

    init() {
        // Check if already authenticated
        const token = localStorage.getItem('admin_token');
        if (token) {
            this.showDashboard();
            this.loadDashboardData();
        }

        this.setupEventListeners();
    }

    setupEventListeners() {
        // Login form
        const loginForm = document.getElementById('login-form');
        if (loginForm) {
            loginForm.addEventListener('submit', (e) => this.handleLogin(e));
        }

        // Logout button
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => this.handleLogout());
        }

        // Navigation links
        const navLinks = document.querySelectorAll('.nav-link');
        navLinks.forEach(link => {
            link.addEventListener('click', (e) => this.handleNavigation(e));
        });

        // Refresh buttons
        const refreshOrdersBtn = document.getElementById('refresh-orders');
        if (refreshOrdersBtn) {
            refreshOrdersBtn.addEventListener('click', () => this.loadOrders());
        }

        const refreshProductsBtn = document.getElementById('refresh-products');
        if (refreshProductsBtn) {
            refreshProductsBtn.addEventListener('click', () => this.loadProducts());
        }

        // Status filter
        const statusFilter = document.getElementById('status-filter');
        if (statusFilter) {
            statusFilter.addEventListener('change', () => this.filterOrders());
        }

        // Notification form
        const notificationForm = document.getElementById('notification-form');
        if (notificationForm) {
            notificationForm.addEventListener('submit', (e) => this.handleSendNotification(e));
        }
    }

    async handleLogin(e) {
        e.preventDefault();
        
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        
        try {
            const response = await fetch('/admin/api/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ username, password }),
            });

            const data = await response.json();

            if (response.ok && data.success) {
                localStorage.setItem('admin_token', data.token);
                this.isAuthenticated = true;
                this.showSuccess('Login successful!', 'auth');
                setTimeout(() => {
                    this.showDashboard();
                    this.loadDashboardData();
                }, 1000);
            } else {
                this.showError(data.message || 'Login failed', 'auth');
            }
        } catch (error) {
            this.showError('Connection error. Please try again.', 'auth');
        }
    }

    handleLogout() {
        localStorage.removeItem('admin_token');
        this.isAuthenticated = false;
        this.showAuthSection();
    }

    showAuthSection() {
        document.getElementById('auth-section').classList.remove('hidden');
        document.getElementById('dashboard-section').classList.add('hidden');
        // Clear form
        document.getElementById('login-form').reset();
    }

    showDashboard() {
        document.getElementById('auth-section').classList.add('hidden');
        document.getElementById('dashboard-section').classList.remove('hidden');
    }

    handleNavigation(e) {
        e.preventDefault();
        
        const section = e.target.dataset.section;
        if (!section) return;

        // Update active nav link
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.remove('active');
        });
        e.target.classList.add('active');

        // Show/hide sections
        document.querySelectorAll('.content-section').forEach(section => {
            section.classList.add('hidden');
        });
        document.getElementById(`${section}-section`).classList.remove('hidden');

        this.currentSection = section;

        // Load section data if needed
        if (section === 'orders' && this.orders.length === 0) {
            this.loadOrders();
        } else if (section === 'products' && this.products.length === 0) {
            this.loadProducts();
        }
    }

    async loadDashboardData() {
        try {
            await Promise.all([
                this.loadStats(),
                this.loadOrders(),
                this.loadProducts()
            ]);
        } catch (error) {
            this.showError('Failed to load dashboard data', 'dashboard');
        }
    }

    async loadStats() {
        try {
            const response = await this.authenticatedFetch('/admin/api/stats');
            const stats = await response.json();

            if (response.ok) {
                document.getElementById('total-orders').textContent = stats.totalOrders || 0;
                document.getElementById('pending-orders').textContent = stats.pendingOrders || 0;
                document.getElementById('revenue').textContent = `$${(stats.revenue || 0).toFixed(2)}`;
                document.getElementById('products-count').textContent = stats.activeProducts || 0;
            }
        } catch (error) {
            console.error('Failed to load stats:', error);
        }
    }

    async loadOrders() {
        try {
            const response = await this.authenticatedFetch('/admin/api/orders');
            const data = await response.json();

            if (response.ok) {
                this.orders = data.orders || [];
                this.renderOrders();
            } else {
                this.showError('Failed to load orders', 'dashboard');
            }
        } catch (error) {
            this.showError('Failed to load orders', 'dashboard');
        }
    }

    async loadProducts() {
        try {
            const response = await this.authenticatedFetch('/admin/api/products');
            const data = await response.json();

            if (response.ok) {
                this.products = data.products || [];
                this.renderProducts();
            } else {
                this.showError('Failed to load products', 'dashboard');
            }
        } catch (error) {
            this.showError('Failed to load products', 'dashboard');
        }
    }

    renderOrders() {
        const tbody = document.getElementById('orders-table');
        
        if (this.orders.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px;">No orders found</td></tr>';
            return;
        }

        tbody.innerHTML = this.orders.map(order => `
            <tr>
                <td>#${order.id}</td>
                <td>${order.customer_name || 'Customer'}</td>
                <td>${this.formatOrderItems(order.items)}</td>
                <td>$${parseFloat(order.total_amount || 0).toFixed(2)}</td>
                <td><span class="status status-${order.status.replace(' ', '-')}">${order.status}</span></td>
                <td>${new Date(order.created_at).toLocaleDateString()}</td>
                <td>
                    <select onchange="dashboard.updateOrderStatus(${order.id}, this.value)" style="padding: 4px;">
                        <option value="">Update Status</option>
                        <option value="placed" ${order.status === 'placed' ? 'selected' : ''}>Placed</option>
                        <option value="received" ${order.status === 'received' ? 'selected' : ''}>Received</option>
                        <option value="in_progress" ${order.status === 'in_progress' ? 'selected' : ''}>In Progress</option>
                        <option value="out_for_delivery" ${order.status === 'out_for_delivery' ? 'selected' : ''}>Out for Delivery</option>
                        <option value="delivered" ${order.status === 'delivered' ? 'selected' : ''}>Delivered</option>
                        <option value="cancelled" ${order.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
                    </select>
                </td>
            </tr>
        `).join('');
    }

    renderProducts() {
        const tbody = document.getElementById('products-table');
        
        if (this.products.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 40px;">No products found</td></tr>';
            return;
        }

        tbody.innerHTML = this.products.map(product => `
            <tr>
                <td>#${product.id}</td>
                <td>${product.name}</td>
                <td>$${parseFloat(product.price || 0).toFixed(2)}</td>
                <td>${product.stock || 0}</td>
                <td><span class="status ${product.is_active ? 'status-delivered' : 'status-cancelled'}">${product.is_active ? 'Active' : 'Inactive'}</span></td>
                <td>
                    <button onclick="dashboard.updateProductStock(${product.id})" class="btn-secondary" style="padding: 4px 8px; font-size: 12px;">Update Stock</button>
                </td>
            </tr>
        `).join('');
    }

    formatOrderItems(items) {
        if (!items || !Array.isArray(items)) return 'N/A';
        return items.map(item => `${item.quantity}x ${item.product_name}`).join(', ');
    }

    filterOrders() {
        const filter = document.getElementById('status-filter').value;
        let filteredOrders = this.orders;

        if (filter) {
            filteredOrders = this.orders.filter(order => order.status === filter);
        }

        // Temporarily update orders for rendering
        const originalOrders = this.orders;
        this.orders = filteredOrders;
        this.renderOrders();
        this.orders = originalOrders;
    }

    async updateOrderStatus(orderId, newStatus) {
        if (!newStatus) return;

        try {
            const response = await this.authenticatedFetch('/admin/api/orders/update-status', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ orderId, status: newStatus }),
            });

            const data = await response.json();

            if (response.ok) {
                this.showSuccess('Order status updated successfully!', 'dashboard');
                this.loadOrders(); // Refresh orders
                this.loadStats(); // Refresh stats
            } else {
                this.showError(data.message || 'Failed to update order status', 'dashboard');
            }
        } catch (error) {
            this.showError('Failed to update order status', 'dashboard');
        }
    }

    async updateProductStock(productId) {
        const newStock = prompt('Enter new stock quantity:');
        if (newStock === null || newStock === '') return;

        const stock = parseInt(newStock);
        if (isNaN(stock) || stock < 0) {
            this.showError('Invalid stock quantity', 'dashboard');
            return;
        }

        try {
            const response = await this.authenticatedFetch('/admin/api/products/update-stock', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ productId, stock }),
            });

            const data = await response.json();

            if (response.ok) {
                this.showSuccess('Product stock updated successfully!', 'dashboard');
                this.loadProducts(); // Refresh products
                this.loadStats(); // Refresh stats
            } else {
                this.showError(data.message || 'Failed to update product stock', 'dashboard');
            }
        } catch (error) {
            this.showError('Failed to update product stock', 'dashboard');
        }
    }

    async handleSendNotification(e) {
        e.preventDefault();

        const customer = document.getElementById('notification-customer').value;
        const type = document.getElementById('notification-type').value;
        const message = document.getElementById('notification-message').value;

        try {
            const response = await this.authenticatedFetch('/admin/api/notifications/send', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ customer, type, message }),
            });

            const data = await response.json();

            if (response.ok) {
                this.showSuccess('Notification sent successfully!', 'dashboard');
                document.getElementById('notification-form').reset();
            } else {
                this.showError(data.message || 'Failed to send notification', 'dashboard');
            }
        } catch (error) {
            this.showError('Failed to send notification', 'dashboard');
        }
    }

    async authenticatedFetch(url, options = {}) {
        const token = localStorage.getItem('admin_token');
        
        const authOptions = {
            ...options,
            headers: {
                ...options.headers,
                'Authorization': `Bearer ${token}`,
            },
        };

        const response = await fetch(url, authOptions);
        
        if (response.status === 401) {
            this.handleLogout();
            throw new Error('Authentication required');
        }

        return response;
    }

    showSuccess(message, section) {
        this.showAlert(message, 'success', section);
    }

    showError(message, section) {
        this.showAlert(message, 'error', section);
    }

    showAlert(message, type, section) {
        const alertId = section === 'auth' ? 'auth-alert' : 'dashboard-alert';
        const alertEl = document.getElementById(alertId);
        
        alertEl.className = `alert alert-${type}`;
        alertEl.textContent = message;
        alertEl.classList.remove('hidden');

        setTimeout(() => {
            alertEl.classList.add('hidden');
        }, 5000);
    }
}

// Initialize dashboard when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.dashboard = new AdminDashboard();
});