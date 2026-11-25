const mongoose = require('mongoose');
const CustomerProduct = require('../models/CustomerProduct');
const Order = require('../models/Order');
const {
  round2,
  num,
  productTotal,
  productPaid,
  cleanPayment,
  syncOrderStatus
} = require('./paymentCalc');

// ---------- helpers ----------
const PRODUCT_FIELDS = [
  'product', 'variant', 'price', 'costPrice', 'quantity', 'productType',
  'billingCycle', 'cycleCount', 'paymentStage', 'startDate', 'endDate',
  'sellerPriceRenewal', 'costPriceRenewal', 'validationEnabled', 'oneTimePayment',
  'domainUrl',
];
const PAYMENT_FIELDS = [
  'date', 'amount', 'withGst', 'gstvalue', 'paymentStage', 'stageNumber',
  'invoiceNo', 'description', 'tdsAmount', 'renewalSellingPrice', 'renewalCostPrice',
];
const LIST_FIELDS =
  'orderId customerId product variant price costPrice quantity productType billingCycle cycleCount ' +
  'paymentStage startDate endDate domainUrl deactive deactiveYear deactiveDate createdAt'; // no paymentHistory (heavy)
const SORT_FIELDS = {
  createdAt: 'createdAt', endDate: 'endDate', startDate: 'startDate',
  price: 'price', product: 'product', productType: 'productType',
};

const isValidId = id => mongoose.Types.ObjectId.isValid(id);
const toBool = v => (v === 'true' ? true : v === 'false' ? false : undefined);
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pick = (obj = {}, keys) =>
  keys.reduce((a, k) => (obj[k] !== undefined ? ((a[k] = obj[k]), a) : a), {});
const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const paging = q => {
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
};
const pageMeta = (page, limit, total) => ({
  page, limit, total, totalPages: Math.ceil(total / limit), hasNext: page * limit < total,
});
const fail = (res, err) => {
  const bad = err.name === 'ValidationError' || err.name === 'CastError';
  res.status(bad ? 400 : 500).json({ success: false, message: err.message });
};
const badId = res => res.status(400).json({ success: false, message: 'Invalid id' });

// Validates price / costPrice / quantity when they are being written.
// Returns an error message string, or null when everything is fine.
const checkProductNumbers = (data) => {
  for (const k of ['price', 'costPrice', 'sellerPriceRenewal', 'costPriceRenewal']) {
    if (data[k] !== undefined && (!Number.isFinite(Number(data[k])) || Number(data[k]) < 0)) {
      return `${k} must be a number of 0 or more`;
    }
  }
  if (data.quantity !== undefined && (!Number.isFinite(Number(data.quantity)) || Number(data.quantity) < 0)) {
    return 'quantity must be a number of 0 or more';
  }
  return null;
};

// ---------- 1. LIST (filter + sort + pagination) ----------
// GET /?customerId=&orderId=&productType=Renewal&billingCycle=yearly&paymentStage=mid&deactive=false
//      &search=hosting&endFrom=2026-01-01&endTo=2026-12-31&sortBy=endDate&order=asc&page=1&limit=20&includePayments=true
exports.getProducts = async (req, res) => {
  try {
    const q = req.query;
    const { page, limit, skip } = paging(q);
    const dir = q.order === 'asc' ? 1 : -1;
    const sort = { [SORT_FIELDS[q.sortBy] || 'createdAt']: dir, _id: dir };

    const filter = {};
    if (q.customerId) { if (!isValidId(q.customerId)) return badId(res); filter.customerId = q.customerId; }
    if (q.orderId)    { if (!isValidId(q.orderId)) return badId(res);    filter.orderId = q.orderId; }
    if (q.productType)  filter.productType = q.productType;
    if (q.billingCycle) filter.billingCycle = q.billingCycle;
    if (q.paymentStage) filter.paymentStage = q.paymentStage;
    const deactive = toBool(q.deactive);
    if (deactive !== undefined) filter.deactive = deactive;

    if (q.endFrom || q.endTo) {                       // endDate is a string -> must be YYYY-MM-DD
      filter.endDate = {};
      if (q.endFrom) filter.endDate.$gte = q.endFrom;
      if (q.endTo)   filter.endDate.$lte = q.endTo;
    }

    const search = (q.search || '').trim().slice(0, 50);
    if (search) {
      const safe = escapeRegex(search);
      filter.$or = [
        { product: { $regex: safe, $options: 'i' } },
        { variant: { $regex: safe, $options: 'i' } },
      ];
    }

    const fields = q.includePayments === 'true' ? LIST_FIELDS + ' paymentHistory' : LIST_FIELDS;
    const hasFilter = Object.keys(filter).length > 0;

    const [data, total] = await Promise.all([
      CustomerProduct.find(filter)
        .select(fields)
        .populate('orderId', 'domainUrl orderDate')
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      hasFilter ? CustomerProduct.countDocuments(filter) : CustomerProduct.estimatedDocumentCount(),
    ]);

    res.json({ success: true, data, pagination: pageMeta(page, limit, total) });
  } catch (err) { fail(res, err); }
};

// ---------- 2. GROUPED BY ORDER  (order -> {p1, p2, ...}) ----------
// GET /grouped?customerId=xxx&page=1&limit=10
exports.getGroupedByOrder = async (req, res) => {
  try {
    const { customerId } = req.query;
    if (!customerId || !isValidId(customerId)) return badId(res);
    const { page, limit, skip } = paging(req.query);
    const match = { customerId: new mongoose.Types.ObjectId(customerId) }; // aggregate does NOT auto-cast

    const [data, countArr] = await Promise.all([
      CustomerProduct.aggregate([
        { $match: match },
        { $sort: { createdAt: -1 } },                                 // uses {customerId, createdAt} index
        { $group: {
            _id: '$orderId',
            createdAt: { $first: '$createdAt' },
            totalProducts: { $sum: 1 },
            // $ifNull so a missing price/quantity counts the same way as in getOrderProducts
            totalAmount: { $sum: { $multiply: [{ $ifNull: ['$price', 0] }, { $ifNull: ['$quantity', 1] }] } },
            totalPaid: { $sum: { $sum: '$paymentHistory.amount' } },
            products: { $push: {
              _id: '$_id', product: '$product', variant: '$variant', price: '$price',
              quantity: '$quantity', productType: '$productType', endDate: '$endDate', deactive: '$deactive',
            } },
        } },
        { $sort: { createdAt: -1, _id: -1 } },
        { $skip: skip },
        { $limit: limit },
        { $project: {
            _id: 0, orderId: '$_id', createdAt: 1, totalProducts: 1, products: 1,
            totalAmount: { $round: ['$totalAmount', 2] },
            totalPaid: { $round: ['$totalPaid', 2] },
            balance: { $round: [{ $subtract: ['$totalAmount', '$totalPaid'] }, 2] },
        } },
      ]),
      CustomerProduct.aggregate([{ $match: match }, { $group: { _id: '$orderId' } }, { $count: 'total' }]),
    ]);

    const total = countArr[0]?.total || 0;
    res.json({ success: true, data, pagination: pageMeta(page, limit, total) });
  } catch (err) { fail(res, err); }
};

// ---------- 3. ONE ORDER with payment totals ----------
// GET /order/:orderId
exports.getOrderProducts = async (req, res) => {
  try {
    if (!isValidId(req.params.orderId)) return badId(res);
    const items = await CustomerProduct.find({ orderId: req.params.orderId })
      .populate('orderId', 'domainUrl orderDate')
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    if (!items.length) return res.status(404).json({ success: false, message: 'Order not found' });

    let grandTotal = 0, grandPaid = 0;
    const products = items.map(p => {
      const total = productTotal(p);
      const paid = productPaid(p);
      const tds = round2((p.paymentHistory || []).reduce((s, x) => s + num(x.tdsAmount), 0));
      grandTotal += total; grandPaid += paid;
      return { ...p, totalAmount: total, paidAmount: paid, tdsAmount: tds, balance: round2(total - paid) };
    });

    grandTotal = round2(grandTotal);
    grandPaid = round2(grandPaid);

    res.json({
      success: true,
      data: {
        orderId: req.params.orderId, customerId: items[0].customerId, products,
        summary: {
          totalProducts: products.length,
          grandTotal,
          grandPaid,
          grandBalance: round2(grandTotal - grandPaid),
        },
      },
    });
  } catch (err) { fail(res, err); }
};

// ---------- 4. RENEWALS (reminders / cron) ----------
// GET /renewals?type=upcoming&days=30&customerId=&page=1&limit=20   |   type=expired
exports.getRenewals = async (req, res) => {
  try {
    const { page, limit, skip } = paging(req.query);
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const today = todayIST();
    const expired = req.query.type === 'expired';

    const filter = { deactive: false, productType: 'Renewal',
      endDate: expired ? { $lt: today } : { $gte: today, $lte: addDays(today, days) } };
    if (req.query.customerId) { if (!isValidId(req.query.customerId)) return badId(res); filter.customerId = req.query.customerId; }

    const dir = expired ? -1 : 1;
    const [data, total] = await Promise.all([
      CustomerProduct.find(filter)
        .select(LIST_FIELDS)
        .populate('orderId', 'domainUrl orderDate')
        .sort({ endDate: dir, _id: dir })
        .skip(skip)
        .limit(limit)
        .lean(), // uses {deactive,endDate,productType}
      CustomerProduct.countDocuments(filter),
    ]);
    res.json({ success: true, data, pagination: pageMeta(page, limit, total) });
  } catch (err) { fail(res, err); }
};

// ---------- 5. GET ONE ----------
exports.getProductById = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return badId(res);
    const doc = await CustomerProduct.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Product not found' });
    res.json({ success: true, data: doc });
  } catch (err) { fail(res, err); }
};

// ---------- 6. CREATE ORDER PRODUCTS (bulk, one DB call) ----------
// POST /   body: { orderId, customerId, products: [ {product, variant, price, ..., paymentHistory:[...]}, ... ] }
exports.createOrderProducts = async (req, res) => {
  try {
    const { orderId, customerId, products } = req.body;
    if (!isValidId(orderId) || !isValidId(customerId)) return badId(res);
    if (!Array.isArray(products) || !products.length || products.length > 50)
      return res.status(400).json({ success: false, message: 'products must be an array of 1-50 items' });

    const order = await Order.findById(orderId).select('_id').lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // validate every product + every payment BEFORE inserting anything
    const docs = products.map(p => {
      const data = pick(p, PRODUCT_FIELDS);
      const err = checkProductNumbers(data);
      if (err) throw Object.assign(new Error(err), { name: 'ValidationError' });
      return {
        ...data,
        orderId, customerId,
        paymentHistory: Array.isArray(p.paymentHistory)
          ? p.paymentHistory.map(x => cleanPayment(pick(x, PAYMENT_FIELDS)))
          : [],
      };
    });

    const created = await CustomerProduct.insertMany(docs);
    const sync = await syncOrderStatus(orderId);

    res.status(201).json({
      success: true, count: created.length, data: created, paymentStatus: sync?.status,
    });
  } catch (err) { fail(res, err); }
};

// ---------- 7. UPDATE PRODUCT ----------
exports.updateProduct = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return badId(res);

    const data = pick(req.body, PRODUCT_FIELDS);
    const numErr = checkProductNumbers(data);
    if (numErr) return res.status(400).json({ success: false, message: numErr });

    const doc = await CustomerProduct.findByIdAndUpdate(
      req.params.id, { $set: data }, { new: true, runValidators: true }
    ).select(LIST_FIELDS).lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Product not found' });

    // price / quantity decide what is owed, so the order status must follow
    if (data.price !== undefined || data.quantity !== undefined) {
      await syncOrderStatus(doc.orderId);
    }

    res.json({ success: true, data: doc });
  } catch (err) { fail(res, err); }
};

// ---------- 8. DEACTIVATE / REACTIVATE ----------
// PATCH /:id/deactivate   body: { deactive: true, deactiveYear: "2026", deactiveDate: "2026-11-20" }
exports.setDeactive = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return badId(res);
    const on = req.body.deactive !== false;
    const set = on
      ? { deactive: true, deactiveYear: req.body.deactiveYear || String(new Date().getFullYear()), deactiveDate: req.body.deactiveDate || todayIST() }
      : { deactive: false, deactiveYear: '', deactiveDate: '' };
    const doc = await CustomerProduct.findByIdAndUpdate(req.params.id, { $set: set }, { new: true })
      .select('deactive deactiveYear deactiveDate').lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Product not found' });
    res.json({ success: true, data: doc });
  } catch (err) { fail(res, err); }
};

// ---------- 9. PAYMENTS (sub-document, atomic) ----------
// POST /:id/payments
exports.addPayment = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return badId(res);

    const payment = cleanPayment(pick(req.body, PAYMENT_FIELDS)); // throws ValidationError -> 400

    const product = await CustomerProduct.findById(req.params.id)
      .select('orderId price quantity productType paymentHistory.amount paymentHistory.tdsAmount').lean();
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    // Overpayment guard. Skipped for Renewal products: renewals are paid at the
    // renewal price, which can legitimately differ from price * quantity.
    if (product.productType !== 'Renewal') {
      const balance = round2(productTotal(product) - productPaid(product));
      if (payment.amount > balance) {
        return res.status(400).json({
          success: false,
          message: `Payment exceeds the balance due (balance: ${Math.max(0, balance)})`,
        });
      }
    }

    const update = { $push: { paymentHistory: payment } };
    if (payment.paymentStage) update.$set = { paymentStage: payment.paymentStage };

    const doc = await CustomerProduct.findByIdAndUpdate(
      req.params.id, update,
      { new: true, runValidators: true }
    ).select({ paymentHistory: { $slice: -1 }, orderId: 1 }).lean();   // return only the new payment

    const sync = await syncOrderStatus(doc.orderId);
    res.status(201).json({ success: true, data: doc.paymentHistory[0], paymentStatus: sync?.status });
  } catch (err) { fail(res, err); }
};

// PUT /:id/payments/:paymentId
exports.updatePayment = async (req, res) => {
  try {
    const { id, paymentId } = req.params;
    if (!isValidId(id) || !isValidId(paymentId)) return badId(res);

    const fields = pick(req.body, PAYMENT_FIELDS);

    // amount / tds / gst are validated and rounded the same way as on create
    if (fields.amount !== undefined) {
      const amt = Number(fields.amount);
      if (!Number.isFinite(amt) || amt <= 0)
        return res.status(400).json({ success: false, message: 'Payment amount must be a number greater than 0' });
      fields.amount = round2(amt);
    }
    if (fields.tdsAmount !== undefined) {
      const tds = Number(fields.tdsAmount);
      if (!Number.isFinite(tds) || tds < 0)
        return res.status(400).json({ success: false, message: 'tdsAmount must be a number of 0 or more' });
      fields.tdsAmount = round2(tds);
    }
    if (fields.gstvalue !== undefined) fields.gstvalue = round2(num(fields.gstvalue));

    const set = {};
    Object.entries(fields).forEach(([k, v]) => { set[`paymentHistory.$.${k}`] = v; });
    if (!Object.keys(set).length) return res.status(400).json({ success: false, message: 'Nothing to update' });

    const doc = await CustomerProduct.findOneAndUpdate(
      { _id: id, 'paymentHistory._id': paymentId }, { $set: set },
      { new: true, runValidators: true }
    ).select('orderId').lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Payment not found' });

    const sync = await syncOrderStatus(doc.orderId);
    res.json({ success: true, message: 'Payment updated', paymentStatus: sync?.status });
  } catch (err) { fail(res, err); }
};

// DELETE /:id/payments/:paymentId
exports.deletePayment = async (req, res) => {
  try {
    const { id, paymentId } = req.params;
    if (!isValidId(id) || !isValidId(paymentId)) return badId(res);

    // match on the payment id too, so a wrong paymentId is a 404 and not a fake success
    const doc = await CustomerProduct.findOneAndUpdate(
      { _id: id, 'paymentHistory._id': paymentId },
      { $pull: { paymentHistory: { _id: paymentId } } },
      { new: true }
    ).select('orderId').lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Payment not found' });

    const sync = await syncOrderStatus(doc.orderId);
    res.json({ success: true, message: 'Payment deleted', paymentStatus: sync?.status });
  } catch (err) { fail(res, err); }
};

// ---------- 10. DELETE ----------
exports.deleteProduct = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return badId(res);

    const doc = await CustomerProduct.findByIdAndDelete(req.params.id).select('orderId').lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Product not found' });

    // its payments are gone with it, so the order status has to be recalculated
    const sync = await syncOrderStatus(doc.orderId);
    res.json({ success: true, message: 'Product deleted', paymentStatus: sync?.status });
  } catch (err) { fail(res, err); }
};

// DELETE /order/:orderId  (all products of the order)
exports.deleteOrderProducts = async (req, res) => {
  try {
    if (!isValidId(req.params.orderId)) return badId(res);

    const r = await CustomerProduct.deleteMany({ orderId: req.params.orderId });
    const sync = await syncOrderStatus(req.params.orderId);   // no-op if the order itself is gone

    res.json({ success: true, deleted: r.deletedCount, paymentStatus: sync?.status });
  } catch (err) { fail(res, err); }
};