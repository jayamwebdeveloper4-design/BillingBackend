const mongoose = require('mongoose');
const Order = require('../models/Order');
const CustomerProduct = require('../models/CustomerProduct');

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

// Set to true if TDS deducted by the customer should count as "paid"
// (i.e. customer pays amount + tdsAmount is deposited with the government).
const COUNT_TDS_AS_PAID = false;

/* ------------------------------------------------------------------ */
/* Number helpers                                                      */
/* ------------------------------------------------------------------ */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const validationError = (message) =>
  Object.assign(new Error(message), { name: 'ValidationError' });

const notFoundError = (message) =>
  Object.assign(new Error(message), { name: 'NotFoundError' });

/* ------------------------------------------------------------------ */
/* Per-product / per-order calculations (single source of truth)       */
/* ------------------------------------------------------------------ */

const entryPaid = (x) =>
  num(x.amount) + (COUNT_TDS_AS_PAID ? num(x.tdsAmount) : 0);

const productTotal = (p) => round2(num(p.price) * num(p.quantity ?? 1));

const productPaid = (p) =>
  round2((p.paymentHistory || []).reduce((s, x) => s + entryPaid(x), 0));

const getPaymentStatus = (totalPaid, totalPrice) => {
  const paid = round2(totalPaid);
  const price = round2(totalPrice);

  if (paid <= 0) return 'Unpaid';
  if (price > 0 && paid >= price) return 'Fully Paid';
  return 'Partially Paid';
};

/* ------------------------------------------------------------------ */
/* Payment entry validation                                            */
/* ------------------------------------------------------------------ */

// Validates and normalises one paymentHistory entry. Throws ValidationError.
const cleanPayment = (p = {}) => {
  const amount = Number(p.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw validationError('Payment amount must be a number greater than 0');
  }

  const out = { ...p, amount: round2(amount) };

  if (p.gstvalue !== undefined) {
    out.gstvalue = round2(num(p.gstvalue));
  }

  if (p.tdsAmount !== undefined) {
    const tds = Number(p.tdsAmount);
    if (!Number.isFinite(tds) || tds < 0) {
      throw validationError('tdsAmount must be a number of 0 or more');
    }
    out.tdsAmount = round2(tds);
  }

  return out;
};

/* ------------------------------------------------------------------ */
/* DB helpers                                                          */
/* ------------------------------------------------------------------ */

// Sum of all payments of an order. Pass the session so it can see
// uncommitted writes when running inside a transaction.
const getTotalPaid = async (orderId, session = null) => {
  if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) return 0;

  const q = CustomerProduct.find({
    orderId: new mongoose.Types.ObjectId(orderId)
  }).select('paymentHistory.amount paymentHistory.tdsAmount');

  if (session) q.session(session);
  const items = await q.lean();

  return round2(items.reduce((s, p) => s + productPaid(p), 0));
};

// Recalculates Order.paymentStatus from the real payments.
// Call after ANY change to products or payments.
const syncOrderStatus = async (orderId, session = null) => {
  if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) return null;

  const q = Order.findById(orderId).select('totalPrice paymentStatus');
  if (session) q.session(session);
  const order = await q.lean();

  if (!order) return null;

  const paid = await getTotalPaid(orderId, session);
  const status = getPaymentStatus(paid, order.totalPrice);

  if (status !== order.paymentStatus) {
    const updateOpts = session ? { session } : {};
    await Order.updateOne(
      { _id: orderId },
      { $set: { paymentStatus: status } },
      updateOpts
    );
  }

  return { paid, status };
};

/**
 * Runs `workFn(session)` inside a transaction when MongoDB supports it
 * (replica set / mongos). On a standalone server it runs `workFn(null)`
 * without a transaction, so callers must handle manual rollback themselves.
 */
const executeWithOptionalTransaction = async (workFn) => {
  let session = null;

  try {
    session = await mongoose.startSession();

    let result;
    await session.withTransaction(async () => {
      result = await workFn(session);
    });

    return result;
  } catch (err) {
    const isReplicaSetError =
      err.message &&
      (err.message.includes('replica set member') ||
        err.message.includes('Transaction numbers are only allowed') ||
        err.code === 20 ||
        err.codeName === 'IllegalOperation');

    if (isReplicaSetError) {
      console.warn(
        'Transactions unavailable (standalone MongoDB); running without one'
      );
      if (session) {
        await session.endSession().catch(() => {});
        session = null;
      }
      return await workFn(null);
    }

    throw err;
  } finally {
    if (session) {
      await session.endSession().catch(() => {});
    }
  }
};


module.exports = {
  COUNT_TDS_AS_PAID,
  round2,
  num,
  validationError,
  notFoundError,
  entryPaid,
  productTotal,
  productPaid,
  getPaymentStatus,
  cleanPayment,
  getTotalPaid,
  syncOrderStatus,
  executeWithOptionalTransaction
};