const Customer = require('../models/Customer');
const Order = require('../models/Order');
const CustomerProduct = require('../models/CustomerProduct');
const Product = require('../models/Product');

// @desc    Get dashboard stats
// @route   GET /api/dashboard/stats
// @access  Private
const getDashboardStats = async (req, res) => {
  try {
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

    const currentYear = new Date().getFullYear();
    const today = new Date();
    const futureDate = new Date();
    futureDate.setDate(today.getDate() + 7);
    const futureStr = futureDate.toISOString().split('T')[0];

    // Fetch collections concurrently
    const [
      totalCustomers,
      totalProducts,
      orders,
      customerProducts
    ] = await Promise.all([
      Customer.countDocuments({}),
      Product.countDocuments({}),
      Order.find({}).sort({ orderDate: -1, createdAt: -1 }).select('-__v').lean(),
      CustomerProduct.find({}).select('-__v').lean()
    ]);

    // Group products and payments by orderId
    const prodMap = new Map();
    customerProducts.forEach(p => {
      const oId = String(p.orderId);
      if (!prodMap.has(oId)) prodMap.set(oId, []);
      prodMap.get(oId).push(p);
    });

    let totalRevenue = 0;
    let totalRenew = 0;
    const monthlyRenew = Array(12).fill(0);
    let pendingRemindersCount = 0;

    orders.forEach(o => {
      const orderSellingPrice = Number(o.totalPrice) || 0;
      const oProds = prodMap.get(String(o._id)) || [];
      const oPayments = oProds.flatMap(p => p.paymentHistory || []);

      // Base order — only if in current year
      const orderDate = parseDateString(o.orderDate || o.createdAt);
      if (orderDate && orderDate.getFullYear() === currentYear) {
        totalRevenue += orderSellingPrice;
        totalRenew += orderSellingPrice;
        const month = orderDate.getMonth();
        if (month >= 0 && month < 12) {
          monthlyRenew[month] += orderSellingPrice;
        }
      }

      // Renewal / updated payments — only if in current year
      oPayments.forEach(p => {
        if (p.paymentType === 'renewal' || p.paymentType === 'updated') {
          const payDate = parseDateString(p.date || o.orderDate);
          if (payDate && payDate.getFullYear() === currentYear) {
            const renewalSelling = (p.renewalSellingPrice !== undefined && p.renewalSellingPrice !== null)
              ? Number(p.renewalSellingPrice)
              : (Number(p.amount) || 0);
            totalRevenue += renewalSelling;
            totalRenew += renewalSelling;
            const month = payDate.getMonth();
            if (month >= 0 && month < 12) {
              monthlyRenew[month] += renewalSelling;
            }
          }
        }
      });

      // Pending Reminders (order endDate within next 7 days and has active validation prods)
      if (o.endDate && o.endDate <= futureStr) {
        const hasActiveValidationProd = oProds.some(p => p.validationEnabled && !p.deactive);
        if (hasActiveValidationProd) {
          pendingRemindersCount++;
        }
      }
    });

    const totalExpress = 0;

    // Recent 4 Orders
    const recentOrderSlice = orders.slice(0, 4);
    const recentCustomerIds = Array.from(new Set(recentOrderSlice.map(o => String(o.customerId)).filter(Boolean)));
    const recentCustomers = await Customer.find({ _id: { $in: recentCustomerIds } }).select('name email').lean();
    const custMap = new Map();
    recentCustomers.forEach(c => custMap.set(String(c._id), c));

    const recentOrders = recentOrderSlice.map(o => {
      const c = custMap.get(String(o.customerId)) || {};
      return {
        ...o,
        customerName: c.name || '',
        customerId: o.customerId,
        email: c.email || ''
      };
    });

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
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getDashboardStats };
