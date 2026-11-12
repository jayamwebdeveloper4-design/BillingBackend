const Customer = require('../models/Customer');
const Product = require('../models/Product');
const RevenueExpense = require('../models/RevenueExpense');

// @desc    Get dashboard stats
// @route   GET /api/dashboard/stats
// @access  Private
const getDashboardStats = async (req, res) => {
  try {
    const customers = await Customer.find({});
    const products = await Product.find({});
    const expressEntries = await RevenueExpense.find({});

    // 1. KPI Metrics — totalRevenue matches Revenue Management "Total Selling" for current year
    let totalRevenue = 0;
    let totalRenew = 0;
    const currentYear = new Date().getFullYear();

    const parseDateString = (dateStr) => {
      if (!dateStr) return null;
      const parts = String(dateStr).trim().split('-');
      if (parts.length === 3) {
        if (parts[0].length === 4) {
          return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
        } else {
          return new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
        }
      }
      const d = new Date(dateStr);
      return isNaN(d.getTime()) ? null : d;
    };

    customers.forEach(c => {
      c.orders?.forEach(o => {
        const orderSellingPrice = Number(o.totalPrice) || 0;

        // Base order — only if in current year
        const orderDate = parseDateString(o.orderDate);
        if (orderDate && orderDate.getFullYear() === currentYear) {
          totalRevenue += orderSellingPrice;
          totalRenew += orderSellingPrice;
        }

        // Renewal / updated payments — only if in current year
        o.payments?.forEach(p => {
          if (p.paymentType === 'renewal' || p.paymentType === 'updated') {
            const payDate = parseDateString(p.date || o.orderDate);
            if (payDate && payDate.getFullYear() === currentYear) {
              const renewalSelling = (p.renewalSellingPrice !== undefined && p.renewalSellingPrice !== null)
                ? Number(p.renewalSellingPrice)
                : (Number(p.amount) || 0);
              totalRevenue += renewalSelling;
              totalRenew += renewalSelling;
            }
          }
        });
      });
    });


    const totalExpress = expressEntries.reduce((sum, e) => sum + (e.amount || 0), 0);

    const totalCustomers = customers.length;
    const totalProducts = products.length;

    // Pending Reminders (using 7 days default)
    const today = new Date();
    const futureDate = new Date();
    futureDate.setDate(today.getDate() + 7);
    const todayStr = today.toISOString().split('T')[0];
    const futureStr = futureDate.toISOString().split('T')[0];

    let pendingRemindersCount = 0;
    customers.forEach(customer => {
      customer.orders?.forEach(order => {
        if (order.endDate && order.endDate <= futureStr) {
          const hasActiveValidationProd = order.products?.some(p => p.validationEnabled && !p.deactive);
          if (hasActiveValidationProd) {
            pendingRemindersCount++;
          }
        }
      });
    });

    // 2. Bar Chart: Monthly Revenue (Total Selling) for Current Year
    const monthlyRenew = Array(12).fill(0);

    customers.forEach(c => {
      c.orders?.forEach(o => {
        const orderSellingPrice = Number(o.totalPrice) || 0;

        // Base order monthly selling
        const orderDate = parseDateString(o.orderDate);
        if (orderDate && orderDate.getFullYear() === currentYear) {
          const month = orderDate.getMonth();
          monthlyRenew[month] += orderSellingPrice;
        }

        // Renewal / updated payments monthly selling
        o.payments?.forEach(p => {
          if (p.paymentType === 'renewal' || p.paymentType === 'updated') {
            const payDate = parseDateString(p.date || o.orderDate);
            if (payDate && payDate.getFullYear() === currentYear) {
              const month = payDate.getMonth();
              const renewalSelling = (p.renewalSellingPrice !== undefined && p.renewalSellingPrice !== null)
                ? Number(p.renewalSellingPrice)
                : (Number(p.amount) || 0);
              monthlyRenew[month] += renewalSelling;
            }
          }
        });
      });
    });


    // 3. Recent 4 Orders
    const allOrders = [];
    customers.forEach(c => {
      c.orders?.forEach(o => {
        allOrders.push({
          ...o.toObject ? o.toObject() : o,
          customerName: c.name,
          customerId: c._id,
          email: c.email
        });
      });
    });

    const recentOrders = allOrders
      .sort((a, b) => {
        const dateA = parseDateString(a.orderDate) || new Date(0);
        const dateB = parseDateString(b.orderDate) || new Date(0);
        return dateB - dateA;
      })
      .slice(0, 4);

    res.json({
      kpis: {
        totalRevenue,
        totalRenew,
        totalCustomers,
        totalProducts,
        pendingReminders: pendingRemindersCount,
        totalExpress
      },
      revenueTrend: monthlyRenew,
      recentOrders
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getDashboardStats };
