const Customer = require('../models/Customer');
const Product = require('../models/Product');
const RevenueExpense = require('../models/RevenueExpense');

const normalizeDateString = (dateVal) => {
  if (!dateVal) return '';
  if (typeof dateVal === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateVal)) {
    return dateVal;
  }
  const d = new Date(dateVal);
  if (!isNaN(d.getTime())) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return String(dateVal);
};

// ── GET /revenue/orders ──────────────────────────────────────────────────────────
// Fetches revenue/renewal and payment records directly from the Customer collection
const getRevenueOrders = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const [customers, products] = await Promise.all([
      Customer.find({}).lean(),
      Product.find({}).lean()
    ]);

    // Build lookup set for oneTimePayment subcategory names
    const oneTimeNames = new Set();
    if (Array.isArray(products)) {
      products.forEach(prod => {
        if (prod.subCategories && Array.isArray(prod.subCategories)) {
          prod.subCategories.forEach(sc => {
            if (sc.oneTimePayment) {
              if (sc.name) oneTimeNames.add(sc.name.trim().toLowerCase());
              if (prod.name && sc.name) {
                oneTimeNames.add(`${prod.name.trim().toLowerCase()} - ${sc.name.trim().toLowerCase()}`);
              }
            }
          });
        }
      });
    }

    const revenueRows = [];
    const paymentRows = [];
    let totalCustomerPaid = 0;
    let totalCustomerPaidNoGst = 0;
    let totalSelling = 0;
    let earliestYear = new Date().getFullYear();

    for (const customer of customers) {
      if (customer.createdAt) {
        const d = new Date(customer.createdAt);
        if (!isNaN(d.getTime())) {
          const y = d.getFullYear();
          if (y >= 2000 && y < earliestYear) earliestYear = y;
        }
      }
      if (customer.orders && Array.isArray(customer.orders)) {
        for (const order of customer.orders) {
          const orderDateStr = normalizeDateString(order.orderDate || order.createdAt);

          const productNames =
            order.products && order.products.length > 0
              ? order.products.map((p) => p.product).filter(Boolean).join(', ')
              : '';

          const prodName = productNames || order.domainUrl || 'Service';

          const isOrderOneTimePayment = (
            (order.products && order.products.length > 0 && order.products.every(p => {
              if (p.oneTimePayment) return true;
              const vName = (p.variant || '').trim().toLowerCase();
              const pName = (p.product || '').trim().toLowerCase();
              return oneTimeNames.has(vName) || oneTimeNames.has(`${pName} - ${vName}`) || oneTimeNames.has(pName);
            })) ||
            (order.payments && Array.isArray(order.payments) && order.payments.some(pay => pay.paymentType === 'oneTimePayment'))
          );
          const basePaymentType = isOrderOneTimePayment ? 'oneTimePayment' : 'base';

          const orderSellingPrice = Number(order.totalPrice) || 0;
          const orderCostPrice =
            order.costPrice !== undefined
              ? Number(order.costPrice)
              : order.products && order.products.length > 0
                ? order.products.reduce((acc, p) => {
                    const isOneTime = p.oneTimePayment || oneTimeNames.has((p.variant || '').trim().toLowerCase()) || oneTimeNames.has(((p.product || '') + ' - ' + (p.variant || '')).trim().toLowerCase());
                    return acc + (isOneTime ? 0 : (Number(p.costPrice) || 0)) * (p.quantity || 1);
                  }, 0)
                : 0;

          if (orderDateStr) {
            const y = parseInt(orderDateStr.slice(0, 4), 10);
            if (!isNaN(y) && y >= 2000 && y < earliestYear) earliestYear = y;

            // 1. Base / One-Time Order Revenue Row
            if ((!startDate || orderDateStr >= startDate) && (!endDate || orderDateStr <= endDate)) {
              revenueRows.push({
                orderId: order._id,
                orderDate: orderDateStr,
                customerName: customer.name,
                productName: prodName,
                paymentType: basePaymentType,
                totalPrice: orderSellingPrice,
                costPrice: orderCostPrice,
              });
              totalSelling += orderSellingPrice;
            }
          }

          // 2. Process payments inside order.payments
          if (order.payments && Array.isArray(order.payments) && order.payments.length > 0) {
            const isFullyPaid = order.paymentStatus === 'Fully Paid';
            const hasMilestones = order.payments.length > 1 || order.payments.some(p => ['advance', 'mid', 'final'].includes(p.paymentStage));

            // When an order is completed with milestone/installment payments,
            // consolidate into a single completed payment entry in Revenue Management.
            // When not completed (partially paid), show the individual installment payments.
            if (isFullyPaid && hasMilestones) {
              const totalAmount = order.payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
              const totalGst = order.payments.reduce((s, p) => s + (p.withGst ? (Number(p.gstvalue) || 0) : 0), 0);
              const hasGst = order.payments.some(p => p.withGst);
              const finalPayment = order.payments[order.payments.length - 1];
              const payDateStr = normalizeDateString(finalPayment?.date || order.orderDate || order.createdAt);

              if (payDateStr) {
                const y = parseInt(payDateStr.slice(0, 4), 10);
                if (!isNaN(y) && y >= 2000 && y < earliestYear) earliestYear = y;
              }

              if (!startDate || payDateStr >= startDate) {
                totalCustomerPaid += (totalAmount + totalGst);
                totalCustomerPaidNoGst += totalAmount;

                paymentRows.push({
                  paymentId: `${order._id}_consolidated`,
                  orderId: order._id,
                  date: payDateStr,
                  customerName: customer.name,
                  productName: prodName,
                  amount: totalAmount,
                  withGst: hasGst,
                  gstvalue: totalGst,
                  paymentType: basePaymentType,
                  isConsolidated: true
                });
              }
            } else {
              // Standard or partially paid order: process individual payments
              for (const payment of order.payments) {
                const payDateStr = normalizeDateString(payment.date || order.orderDate || order.createdAt);

                if (payDateStr) {
                  const y = parseInt(payDateStr.slice(0, 4), 10);
                  if (!isNaN(y) && y >= 2000 && y < earliestYear) earliestYear = y;
                }

                if (startDate && payDateStr < startDate) continue;

                const pType = (payment.paymentType === 'oneTimePayment' || (payment.paymentType === 'base' && isOrderOneTimePayment))
                  ? 'oneTimePayment'
                  : (payment.paymentType || 'base');
                const pAmount = Number(payment.amount) || 0;
                const pGst = payment.withGst ? Number(payment.gstvalue) || 0 : 0;
                const pCost = payment.renewalCostPrice !== undefined ? Number(payment.renewalCostPrice) : orderCostPrice;
                const pDescription = payment.description ? `${prodName} - ${payment.description}` : prodName;

                totalCustomerPaid += (pAmount + pGst);
                totalCustomerPaidNoGst += pAmount;

                // If payment type is renewal or updated, add to revenue rows as well
                if (pType === 'renewal' || pType === 'updated') {
                  const renewalSelling = (payment.renewalSellingPrice !== undefined && payment.renewalSellingPrice !== null) ? Number(payment.renewalSellingPrice) : pAmount;
                  revenueRows.push({
                    orderId: order._id,
                    orderDate: payDateStr,
                    customerName: customer.name,
                    productName: pDescription,
                    paymentType: pType,
                    totalPrice: renewalSelling,
                    costPrice: pCost,
                  });
                  totalSelling += renewalSelling;
                }

                // Customer Payments Row
                paymentRows.push({
                  paymentId: payment._id || `${order._id}_pay_${payDateStr}`,
                  orderId: order._id,
                  date: payDateStr,
                  customerName: customer.name,
                  productName: pDescription,
                  amount: pAmount,
                  withGst: !!payment.withGst,
                  gstvalue: pGst,
                  paymentType: pType,
                  stage: payment.paymentStage
                });
              }
            }
          }
        }
      }
    }

    const pendingAmount = Math.max(0, totalSelling - totalCustomerPaid);

    res.json({
      orders: revenueRows,
      totalCustomerPaid,
      totalCustomerPaidNoGst,
      payments: paymentRows,
      totalSelling,
      pendingAmount,
      startYear: earliestYear,
    });
  } catch (err) {
    console.error('[RevenueController] getRevenueOrders error:', err);
    res.status(500).json({ message: 'Failed to fetch revenue orders' });
  }
};

// ── GET /revenue/express ─────────────────────────────────────────────────────────
const getExpressEntries = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const query = {};
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = startDate;
      if (endDate) query.date.$lte = endDate;
    }
    const entries = await RevenueExpense.find(query).sort({ date: -1, createdAt: -1 }).lean();
    res.json(entries);
  } catch (err) {
    console.error('[RevenueController] getExpressEntries error:', err);
    res.status(500).json({ message: 'Failed to fetch express entries' });
  }
};

// ── POST /revenue/express ────────────────────────────────────────────────────────
const addExpressEntry = async (req, res) => {
  try {
    const { date, description, amount } = req.body;

    if (!date || !description || amount === undefined) {
      return res.status(400).json({ message: 'Date, description and amount are required' });
    }

    const entry = await RevenueExpense.create({ date, description, amount: Number(amount) });
    res.status(201).json(entry);
  } catch (err) {
    console.error('[RevenueController] addExpressEntry error:', err);
    res.status(500).json({ message: 'Failed to add express entry' });
  }
};

// ── DELETE /revenue/express/:id ──────────────────────────────────────────────────
const deleteExpressEntry = async (req, res) => {
  try {
    const entry = await RevenueExpense.findByIdAndDelete(req.params.id);
    if (!entry) {
      return res.status(404).json({ message: 'Express entry not found' });
    }
    res.json({ message: 'Express entry deleted' });
  } catch (err) {
    console.error('[RevenueController] deleteExpressEntry error:', err);
    res.status(500).json({ message: 'Failed to delete express entry' });
  }
};

module.exports = {
  getRevenueOrders,
  getExpressEntries,
  addExpressEntry,
  deleteExpressEntry,
};
