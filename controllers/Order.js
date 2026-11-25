const mongoose = require('mongoose');
const Order = require('../models/Order');
const CustomerProduct = require('../models/CustomerProduct');
const Customer = require('../models/Customer');
const SmtpSetting = require('../models/SMTPSetting');
const sendEmail = require('../utils/sendEmail');
// const { getOrderManagementData } = require('./orderManagementController');
const {
  round2,
  num,
  validationError,
  notFoundError,
  productPaid,
  getPaymentStatus,
  cleanPayment,
  getTotalPaid,
  syncOrderStatus,
  executeWithOptionalTransaction
} = require('./paymentCalc');

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const fail = (res, err) => {
  if (err.name === 'NotFoundError') {
    return res.status(404).json({
      success: false,
      message: err.message
    });
  }

  const bad = err.name === 'ValidationError' || err.name === 'CastError';

  res.status(bad ? 400 : 500).json({
    success: false,
    message: err.message
  });
};

const badId = (res) =>
  res.status(400).json({
    success: false,
    message: 'Invalid ID'
  });

const getPagination = (query) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));

  return {
    page,
    limit,
    skip: (page - 1) * limit
  };
};

const resolveCustomerDetails = (order) => {
  if (order.customerDetails && order.customerDetails.name) {
    return order.customerDetails;
  }
  if (order.customerId && typeof order.customerId === 'object') {
    return {
      name: order.customerId.name || '',
      phone: order.customerId.phone || [],
      email: order.customerId.email || [],
      gstin: order.customerId.gstin || '',
      address: order.customerId.address || '',
      contactPerson: order.customerId.contactPerson || ''
    };
  }
  return order.customerDetails || null;
};

// totalPaid / balance computed from the same helpers used everywhere else
const paymentSummary = (order, products) => {
  const totalPaid = round2(
    products.reduce((s, p) => s + productPaid(p), 0)
  );

  return {
    totalPaid,
    balance: Math.max(0, round2(num(order.totalPrice) - totalPaid))
  };
};

const attachProducts = async (orders) => {
  if (!orders.length) return [];

  const orderIds = orders.map((order) => order._id);

  const products = await CustomerProduct.find({
    orderId: { $in: orderIds }
  }).lean();

  const productMap = new Map();

  for (const product of products) {
    const key = String(product.orderId);

    if (!productMap.has(key)) {
      productMap.set(key, []);
    }

    productMap.get(key).push(product);
  }

  return orders.map((order) => {
    const orderProducts = productMap.get(String(order._id)) || [];

    return {
      ...order,
      customerDetails: resolveCustomerDetails(order),
      products: orderProducts,
      ...paymentSummary(order, orderProducts)
    };
  });
};

// Recalculate + save the order's status from the real payments.
const refreshOrderStatus = async (order, session) => {
  const totalPaid = await getTotalPaid(order._id, session);

  order.paymentStatus = getPaymentStatus(
    totalPaid,
    Number(order.totalPrice) || 0
  );
  await order.save(session ? { session } : {});

  return totalPaid;
};

// Parse date safely to UTC Date
const parseDateToUTC = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    return isNaN(value.getTime())
      ? null
      : new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  if (typeof value !== 'string') return null;

  const clean = value.trim();
  let year, month, day;
  const iso = clean.match(/^(\d{4})[-.](\d{2})[-.](\d{2})$/);
  const local = clean.match(/^(\d{2})[.-](\d{2})[.-](\d{4})$/);

  if (iso) {
    [, year, month, day] = iso;
  } else if (local) {
    [, day, month, year] = local;
  } else {
    return null;
  }

  const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return isNaN(d.getTime()) ? null : d;
};

const formatISODate = (date) => {
  if (!date || isNaN(date.getTime())) return '';
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const calculateNextCycleEndDate = (startDateUTC, billingCycle) => {
  const result = new Date(startDateUTC);
  const monthsToAdd = String(billingCycle).toLowerCase() === 'monthly' ? 1 : 12;
  const originalDay = result.getUTCDate();

  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + monthsToAdd);

  const lastDayOfMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
  ).getUTCDate();

  result.setUTCDate(Math.min(originalDay, lastDayOfMonth));
  return result;
};

// Synchronize renewal cycle state for Renewal products:
// Root document holds the CURRENT active cycle (Cycle 1).
// renewalHistory holds the NEXT upcoming cycle (Cycle 2, Unpaid) waiting for renewal.
const syncRenewalHistoryForProduct = async (product, paymentEntry) => {
  if (!product || product.productType !== 'Renewal') return;

  const targetCycleTotal = Number(product.sellerPriceRenewal) || Number(product.price) || 0;
  const cycleType = String(product.billingCycle || 'yearly').toLowerCase();

  const totalPaidCurrentCycle = (product.paymentHistory || []).reduce(
    (sum, p) => sum + (Number(p.amount) || 0),
    0
  );
  const productPrice = Number(product.price) || targetCycleTotal;
  const isCurrentCycleFullyPaid = productPrice > 0 && totalPaidCurrentCycle >= productPrice;

  let existingHistory = Array.isArray(product.renewalHistory) ? [...product.renewalHistory] : [];

  // When current cycle is fully paid, schedule the upcoming NEXT cycle (Cycle 2+) in renewalHistory as unpaid
  if (isCurrentCycleFullyPaid) {
    const upcomingIdx = existingHistory.findIndex((h) => h.renewalStatus === 'upcoming');
    if (upcomingIdx === -1) {
      const currentEndUTC = parseDateToUTC(product.endDate);
      if (currentEndUTC) {
        const nextStartUTC = currentEndUTC;
        const nextEndUTC = calculateNextCycleEndDate(nextStartUTC, cycleType);
        const nextStartDate = formatISODate(nextStartUTC);
        const nextEndDate = formatISODate(nextEndUTC);
        const nextCycleNumber = (Number(product.cycleCount) || 1) + 1;

        existingHistory.push({
          cycleNumber: nextCycleNumber,
          startDate: nextStartDate,
          endDate: nextEndDate,
          totalAmount: targetCycleTotal,
          paidAmount: 0,
          paymentStatus: 'Unpaid',
          renewalStatus: 'upcoming',
          paymentStages: []
        });

        // Check global Auto Reminder toggle in SMTP DB:
        try {
          const smtp = await SmtpSetting.findOne().lean();
          if (smtp && smtp.autoReminder === true) {
            let recipientEmail = '';
            let customerName = 'Customer';

            if (product.customerDetails?.email?.[0]) {
              recipientEmail = product.customerDetails.email[0];
              customerName = product.customerDetails.name || customerName;
            } else if (product.customerId) {
              const cust = await Customer.findById(product.customerId).select('email name').lean();
              if (cust) {
                recipientEmail = Array.isArray(cust.email) ? cust.email[0] : cust.email;
                customerName = cust.name || customerName;
              }
            }

            if (recipientEmail) {
              const domain = product.domainUrl || '';
              const subject = `Renewal Reminder (Next Cycle) for ${product.product}${domain ? ` - ${domain}` : ''}`;
              const content = `Dear ${customerName},\n\nYour current cycle for ${product.product} is complete. Your next renewal cycle (Cycle ${nextCycleNumber}) has been scheduled.\n\nStart Date: ${nextStartDate}\nEnd Date: ${nextEndDate}\nRenewal Amount: Rs. ${targetCycleTotal}/-\n\nPlease make payment to avoid service interruption.\n\nThank you,\nJayam Web Solutions`;

              await sendEmail({
                to: recipientEmail,
                subject,
                text: content,
                html: content.replace(/\n/g, '<br/>')
              });
              product.reminder = `AutoReminder_C${nextCycleNumber}`;
            }
          }
        } catch (emailErr) {
          console.warn('[Order.js] Auto reminder email dispatch failed:', emailErr.message);
        }
      }
    }
  }

  product.renewalHistory = existingHistory;
};

/* ------------------------------------------------------------------ */
/* 1. CREATE ORDER                                                     */
/* POST /api/orders                                                    */
/* ------------------------------------------------------------------ */

const createOrder = async (req, res) => {
  try {
    const {
      customerId,
      orderDate,
      domainUrl = '',
      startDate = '',
      endDate = '',
      products = []
    } = req.body;

    if (!customerId || !isValidId(customerId)) {
      return res.status(400).json({
        success: false,
        message: 'Valid customerId is required'
      });
    }

    if (!Array.isArray(products) || products.length > 100) {
      return res.status(400).json({
        success: false,
        message: 'Products must be an array with maximum 100 items'
      });
    }

    const hasTotal =
      req.body.totalPrice !== undefined &&
      req.body.totalPrice !== null &&
      req.body.totalPrice !== '';

    if (
      hasTotal &&
      (!Number.isFinite(Number(req.body.totalPrice)) ||
        Number(req.body.totalPrice) < 0)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid totalPrice'
      });
    }

    // Build + validate product docs BEFORE touching the DB, so a bad
    // payment amount never leaves a half-created order behind.
    const productDocs = products.map((p) => {
      const { customerDetails: _cd, paymentStatus: _ps, ...rest } = p;

      return {
        ...rest,
        price: round2(num(p.price)),
        costPrice: round2(num(p.costPrice)),
        quantity: Number(p.quantity) || 1,
        paymentHistory: Array.isArray(p.paymentHistory)
          ? p.paymentHistory.map(cleanPayment)
          : []
      };
    });

    // totalPrice: use the client value if sent, otherwise derive from products
    const totalPrice = hasTotal
      ? round2(Number(req.body.totalPrice))
      : round2(
          productDocs.reduce((s, p) => s + p.price * p.quantity, 0)
        );

    const totalPaid = round2(
      productDocs.reduce((s, p) => s + productPaid(p), 0)
    );

    if (totalPrice > 0 && totalPaid > totalPrice) {
      return res.status(400).json({
        success: false,
        message: 'Payments exceed the order total'
      });
    }

    // Status is always derived, never trusted from the client
    const paymentStatus = getPaymentStatus(totalPaid, totalPrice);

    const responseData = await executeWithOptionalTransaction(async (session) => {
      const opts = session ? { session } : {};

      const customerQuery = Customer.findById(customerId)
        .select('name phone email gstin address contactPerson')
        .lean();
      if (session) customerQuery.session(session);
      const customer = await customerQuery;

      if (!customer) {
        throw validationError('Customer not found');
      }

      const [order] = await Order.create(
        [
          {
            customerId,
            orderDate: orderDate || new Date().toISOString().split('T')[0],
            domainUrl: String(domainUrl).trim(),
            totalPrice,
            paymentStatus,
            startDate,
            endDate,
            customerDetails: null
          }
        ],
        opts
      );

      let createdProducts = [];

      if (productDocs.length) {
        const docs = productDocs.map((p) => ({
          ...p,
          orderId: order._id,
          customerId: order.customerId,
          customerDetails: null
        }));

        try {
          createdProducts = await CustomerProduct.insertMany(docs, opts);
        } catch (err) {
          // No transaction => manual rollback so no empty order is left behind
          if (!session) {
            await Order.deleteOne({ _id: order._id }).catch(() => {});
            await CustomerProduct.deleteMany({ orderId: order._id }).catch(
              () => {}
            );
          }
          throw err;
        }
      }

      return {
        ...order.toObject(),
        customerDetails: {
          name: customer.name || '',
          phone: customer.phone || [],
          email: customer.email || [],
          gstin: customer.gstin || '',
          address: customer.address || '',
          contactPerson: customer.contactPerson || ''
        },
        products: createdProducts,
        totalPaid,
        balance: Math.max(0, round2(totalPrice - totalPaid))
      };
    });

    res.status(201).json({
      success: true,
      data: responseData
    });
  } catch (err) {
    fail(res, err);
  }
};

/* ------------------------------------------------------------------ */
/* 2. GET ALL ORDERS                                                   */
/* GET /api/orders                                                     */
/* ------------------------------------------------------------------ */

const getOrders = async (req, res) => {
  try {
    const { customerId, search, status } = req.query;

    const filter = {};

    if (customerId) {
      if (!isValidId(customerId)) return badId(res);
      filter.customerId = new mongoose.Types.ObjectId(customerId);
    }

    if (status) {
      filter.paymentStatus = status;
    }

    if (search && search.trim()) {
      const q = search.trim().slice(0, 100);
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const matchingCustomers = await Customer.find({
        $or: [
          { name: { $regex: escaped, $options: 'i' } },
          { contactPerson: { $regex: escaped, $options: 'i' } }
        ]
      })
        .select('_id')
        .lean();
      const matchingCustomerIds = matchingCustomers.map((c) => c._id);

      filter.$or = [
        { domainUrl: { $regex: escaped, $options: 'i' } },
        { customerId: { $in: matchingCustomerIds } },
        { 'customerDetails.name': { $regex: escaped, $options: 'i' } },
        {
          'customerDetails.contactPerson': {
            $regex: escaped,
            $options: 'i'
          }
        }
      ];
    }

    const { page, limit, skip } = getPagination(req.query);

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate('customerId', 'name phone email gstin address contactPerson')
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      Order.countDocuments(filter)
    ]);

    const data = await attachProducts(orders);

    res.json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    fail(res, err);
  }
};

/* ------------------------------------------------------------------ */
/* 3. GET ORDER BY ID                                                  */
/* GET /api/orders/:id                                                 */
/* ------------------------------------------------------------------ */

const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) return badId(res);

    const order = await Order.findById(id)
      .populate('customerId', 'name phone email gstin address contactPerson')
      .lean();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    const products = await CustomerProduct.find({
      orderId: order._id
    }).lean();

    res.json({
      success: true,
      data: {
        ...order,
        customerDetails: resolveCustomerDetails(order),
        products,
        ...paymentSummary(order, products)
      }
    });
  } catch (err) {
    fail(res, err);
  }
};

/* ------------------------------------------------------------------ */
/* 4. UPDATE ORDER                                                     */
/* PUT /api/orders/:id                                                 */
/* ------------------------------------------------------------------ */
// paymentStatus is NOT editable: it is always derived from the payments.

const updateOrder = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) return badId(res);

    const allowedFields = [
      'orderDate',
      'domainUrl',
      'totalPrice',
      'startDate',
      'endDate',
      'customerDetails'
    ];

    const updates = {};

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        updates[field] = req.body[field];
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update'
      });
    }

    if (updates.totalPrice !== undefined) {
      const tp = Number(updates.totalPrice);

      if (!Number.isFinite(tp) || tp < 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid totalPrice'
        });
      }

      updates.totalPrice = round2(tp);
    }

    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      { $set: updates },
      {
        new: true,
        runValidators: true
      }
    ).lean();

    if (!updatedOrder) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // totalPrice may have changed, so the status must be recalculated
    const sync = await syncOrderStatus(updatedOrder._id);
    if (sync) updatedOrder.paymentStatus = sync.status;

    const products = await CustomerProduct.find({
      orderId: updatedOrder._id
    }).lean();

    res.json({
      success: true,
      data: {
        ...updatedOrder,
        products,
        ...paymentSummary(updatedOrder, products)
      }
    });
  } catch (err) {
    fail(res, err);
  }
};

/* ------------------------------------------------------------------ */
/* 5. DELETE ORDER                                                     */
/* DELETE /api/orders/:id                                              */
/* ------------------------------------------------------------------ */
// Children are deleted first and the order last, so if something fails
// midway on a standalone DB the order still exists and can be retried.

const deleteOrder = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) return badId(res);

    const deleted = await executeWithOptionalTransaction(async (session) => {
      const opts = session ? { session } : {};

      const orderQuery = Order.findById(id).select('_id');
      if (session) orderQuery.session(session);
      const order = await orderQuery;

      if (!order) return false;

      await CustomerProduct.deleteMany({ orderId: order._id }, opts);
      await Order.deleteOne({ _id: order._id }, opts);

      return true;
    });

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    res.json({
      success: true,
      message: 'Order and associated products deleted successfully'
    });
  } catch (err) {
    fail(res, err);
  }
};

/* ------------------------------------------------------------------ */
/* 6. GET ORDERS BY CUSTOMER                                           */
/* GET /api/orders/customer/:customerId                                */
/* ------------------------------------------------------------------ */

const getOrdersByCustomer = async (req, res) => {
  try {
    const { customerId } = req.params;

    if (!isValidId(customerId)) return badId(res);

    const { page, limit, skip } = getPagination(req.query);

    const filter = {
      customerId: new mongoose.Types.ObjectId(customerId)
    };

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate('customerId', 'name phone email gstin address contactPerson')
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      Order.countDocuments(filter)
    ]);

    const data = await attachProducts(orders);

    res.json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    fail(res, err);
  }
};

/* ------------------------------------------------------------------ */
/* 7. RECORD ORDER PAYMENT                                             */
/* POST /api/orders/:id/payments                                       */
/* ------------------------------------------------------------------ */

const recordOrderPayment = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) return badId(res);

    const {
      amount,
      date = new Date().toISOString().split('T')[0],
      paymentStage = 'full',
      stageNumber = 1,
      withGst = false,
      gstRate = 18,
      gstvalue = 0,
      invoiceNo = '',
      description = '',
      tdsAmount = 0,
      productId = null,
      productIds = null,
      splits = null
    } = req.body;

    const numericAmount = round2(Number(amount));

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid payment amount is required'
      });
    }

    // Determine Base and GST amounts on backend
    const effectiveGstRate = num(gstRate) > 0 ? num(gstRate) : 18;
    let totalBase = numericAmount;
    let totalGst = 0;

    if (withGst) {
      // If client already computed explicit gstvalue and amount is base
      if (num(gstvalue) > 0 && Math.abs(numericAmount + num(gstvalue) - round2(numericAmount * (1 + effectiveGstRate / 100))) < 0.1) {
        totalBase = numericAmount;
        totalGst = round2(num(gstvalue));
      } else {
        // Amount entered is gross (inclusive of GST)
        totalBase = round2(numericAmount / (1 + effectiveGstRate / 100));
        totalGst = round2(numericAmount - totalBase);
      }
    }

    const responseData = await executeWithOptionalTransaction(async (session) => {
      const opts = session ? { session } : {};

      const orderQuery = Order.findById(id);
      if (session) orderQuery.session(session);
      const order = await orderQuery;

      if (!order) {
        throw notFoundError('Order not found');
      }

      // Overpayment guard against base price (catches double-clicks & excess pay)
      const orderTotal = Number(order.totalPrice) || 0;
      if (orderTotal > 0) {
        const alreadyPaid = await getTotalPaid(order._id, session);
        if (round2(alreadyPaid + totalBase) > round2(orderTotal + 0.05)) {
          throw validationError(
            `Payment base amount (₹${totalBase}) exceeds the remaining balance due (₹${round2(
              Math.max(0, orderTotal - alreadyPaid)
            )})`
          );
        }
      }

      // Resolve targeted products
      let targetProductIds = [];
      if (productId && isValidId(productId)) {
        targetProductIds = [productId];
      } else if (Array.isArray(productIds) && productIds.length > 0) {
        targetProductIds = productIds.filter((pid) => isValidId(pid));
      } else if (Array.isArray(splits) && splits.length > 0) {
        targetProductIds = splits.map((s) => s.productId).filter((pid) => isValidId(pid));
      }

      let targetProducts = [];
      if (targetProductIds.length > 0) {
        const q = CustomerProduct.find({
          _id: { $in: targetProductIds },
          orderId: order._id
        });
        if (session) q.session(session);
        targetProducts = await q;
      } else {
        const q = CustomerProduct.find({ orderId: order._id }).sort({ createdAt: 1, _id: 1 });
        if (session) q.session(session);
        targetProducts = await q;
      }

      if (!targetProducts.length) {
        if (productId) throw notFoundError('Product not found in this order');

        // Fallback: create general service product if order has no products
        const paymentEntry = cleanPayment({
          amount: totalBase,
          date,
          paymentStage,
          stageNumber: Number(stageNumber) || 1,
          withGst: Boolean(withGst),
          gstvalue: totalGst,
          invoiceNo: invoiceNo || '',
          description: description || '',
          tdsAmount: num(tdsAmount)
        });

        const [createdProduct] = await CustomerProduct.create(
          [
            {
              orderId: order._id,
              customerId: order.customerId,
              product: 'General Service',
              variant: 'Standard',
              price: order.totalPrice,
              costPrice: 0,
              quantity: 1,
              startDate: order.startDate || order.orderDate,
              endDate: order.endDate || order.orderDate,
              paymentHistory: [paymentEntry]
            }
          ],
          opts
        );
        targetProducts = [createdProduct];
      }

      const updatedProducts = [];
      const allocations = [];

      // Case A: Manual splits provided by user (Custom Split mode)
      if (Array.isArray(splits) && splits.length > 0 && targetProducts.length > 1) {
        const positiveSplits = splits.filter((s) => Number(s.amount) > 0);
        let splitBaseAllocated = 0;
        let splitGstAllocated = 0;
        let processedCount = 0;

        for (const item of positiveSplits) {
          processedCount += 1;
          const isLast = processedCount === positiveSplits.length;
          const targetProduct = targetProducts.find((p) => String(p._id) === String(item.productId));
          if (!targetProduct) continue;

          const itemGross = round2(Number(item.amount) || 0);
          let itemBase = itemGross;
          let itemGst = 0;

          if (withGst) {
            if (isLast) {
              itemBase = round2(totalBase - splitBaseAllocated);
              itemGst = round2(totalGst - splitGstAllocated);
            } else {
              itemBase = round2(itemGross / (1 + effectiveGstRate / 100));
              itemGst = round2(itemGross - itemBase);
              splitBaseAllocated = round2(splitBaseAllocated + itemBase);
              splitGstAllocated = round2(splitGstAllocated + itemGst);
            }
          } else {
            if (isLast) {
              itemBase = round2(totalBase - splitBaseAllocated);
            } else {
              itemBase = itemGross;
              splitBaseAllocated = round2(splitBaseAllocated + itemBase);
            }
          }

          const paymentEntry = cleanPayment({
            amount: itemBase,
            date: item.date || date,
            paymentStage: item.paymentStage || paymentStage,
            stageNumber: Number(item.stageNumber || stageNumber) || 1,
            withGst: Boolean(withGst),
            gstvalue: itemGst,
            invoiceNo: item.invoiceNo || invoiceNo || '',
            description: item.description || description || '',
            tdsAmount: num(item.tdsAmount !== undefined ? item.tdsAmount : 0)
          });

          targetProduct.paymentHistory.push(paymentEntry);
          targetProduct.paymentStage = paymentEntry.paymentStage;
          syncRenewalHistoryForProduct(targetProduct, paymentEntry);
          await targetProduct.save(opts);
          updatedProducts.push(targetProduct);

          allocations.push({
            productId: targetProduct._id,
            productName: targetProduct.product,
            baseAmount: itemBase,
            gstAmount: itemGst,
            grossAmount: round2(itemBase + itemGst)
          });
        }
      }
      // Case B: Automatic Proportional Split across multiple products (Backend Engine)
      else if (targetProducts.length > 1) {
        // Calculate each product's unpaid balance
        const productBalances = targetProducts.map((p) => {
          const bal = Math.max(0, round2(productTotal(p) - productPaid(p)));
          return { product: p, balance: bal, total: productTotal(p) };
        });

        const sumBalances = round2(productBalances.reduce((s, x) => s + x.balance, 0));
        const sumTotals = round2(productBalances.reduce((s, x) => s + x.total, 0));
        const basis = sumBalances > 0 ? 'balance' : 'total';
        const totalBasis = basis === 'balance' ? sumBalances : (sumTotals || 1);

        let allocatedBase = 0;
        let allocatedGst = 0;

        for (let i = 0; i < productBalances.length; i++) {
          const { product, balance, total } = productBalances[i];
          const isLast = i === productBalances.length - 1;

          let splitBase = 0;
          let splitGst = 0;

          if (isLast) {
            // Remainder protection guarantees 100% exact match
            splitBase = Math.max(0, round2(totalBase - allocatedBase));
            splitGst = Math.max(0, round2(totalGst - allocatedGst));
          } else {
            const ratio = (basis === 'balance' ? balance : total) / totalBasis;
            splitBase = round2(totalBase * ratio);
            splitGst = round2(totalGst * ratio);
            allocatedBase = round2(allocatedBase + splitBase);
            allocatedGst = round2(allocatedGst + splitGst);
          }

          if (splitBase <= 0 && splitGst <= 0) continue;

          const paymentEntry = cleanPayment({
            amount: splitBase,
            date,
            paymentStage,
            stageNumber: Number(stageNumber) || 1,
            withGst: Boolean(withGst),
            gstvalue: splitGst,
            invoiceNo: invoiceNo || '',
            description: description || '',
            tdsAmount: num(tdsAmount)
          });

          product.paymentHistory.push(paymentEntry);
          product.paymentStage = paymentStage;
          await syncRenewalHistoryForProduct(product, paymentEntry);
          await product.save(opts);
          updatedProducts.push(product);

          allocations.push({
            productId: product._id,
            productName: product.product,
            baseAmount: splitBase,
            gstAmount: splitGst,
            grossAmount: round2(splitBase + splitGst)
          });
        }
      }
      // Case C: Single targeted product
      else {
        const targetProduct = targetProducts[0];
        const paymentEntry = cleanPayment({
          amount: totalBase,
          date,
          paymentStage,
          stageNumber: Number(stageNumber) || 1,
          withGst: Boolean(withGst),
          gstvalue: totalGst,
          invoiceNo: invoiceNo || '',
          description: description || '',
          tdsAmount: num(tdsAmount)
        });

        targetProduct.paymentHistory.push(paymentEntry);
        if (paymentStage) targetProduct.paymentStage = paymentStage;
        await syncRenewalHistoryForProduct(targetProduct, paymentEntry);
        await targetProduct.save(opts);
        updatedProducts.push(targetProduct);

        allocations.push({
          productId: targetProduct._id,
          productName: targetProduct.product,
          baseAmount: totalBase,
          gstAmount: totalGst,
          grossAmount: round2(totalBase + totalGst)
        });
      }

      const totalPaid = await refreshOrderStatus(order, session);

      return {
        order,
        products: updatedProducts,
        totalPaid,
        summary: {
          grossAmount: numericAmount,
          totalBase,
          totalGst,
          withGst: Boolean(withGst),
          gstRate: effectiveGstRate
        },
        allocations
      };
    });

    res.json({
      success: true,
      message: 'Payment recorded and distributed successfully',
      data: responseData
    });
  } catch (err) {
    fail(res, err);
  }
};

/* ------------------------------------------------------------------ */
/* 8. DELETE ORDER PAYMENT                                             */
/* DELETE /api/orders/:id/payments/:paymentId                          */
/* ------------------------------------------------------------------ */

const deleteOrderPayment = async (req, res) => {
  try {
    const { id, paymentId } = req.params;

    if (!isValidId(id) || !isValidId(paymentId)) {
      return badId(res);
    }

    const responseData = await executeWithOptionalTransaction(async (session) => {
      const opts = session ? { session } : {};

      const orderQuery = Order.findById(id);
      if (session) orderQuery.session(session);
      const order = await orderQuery;

      if (!order) {
        throw notFoundError('Order not found');
      }

      const updateResult = await CustomerProduct.updateMany(
        { orderId: order._id },
        {
          $pull: {
            paymentHistory: { _id: new mongoose.Types.ObjectId(paymentId) }
          }
        },
        opts
      );

      if (updateResult.modifiedCount === 0) {
        throw notFoundError('Payment record not found');
      }

      const totalPaid = await refreshOrderStatus(order, session);

      return {
        order,
        totalPaid
      };
    });

    res.json({
      success: true,
      message: 'Payment deleted successfully',
      data: responseData
    });
  } catch (err) {
    fail(res, err);
  }
};

module.exports = {
  createOrder,
  getOrders,
  getOrderById,
  updateOrder,
  deleteOrder,
  getOrdersByCustomer,
  recordOrderPayment,
  deleteOrderPayment,
};