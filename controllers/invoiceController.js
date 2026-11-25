const puppeteer = require('puppeteer');
const mongoose = require('mongoose');
const CustomerProduct = require('../models/CustomerProduct');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const GstSetting = require('../models/GstSetting');
const { generateInvoiceHtml } = require('../templates/invoiceTemplate');
const sendEmail = require('../utils/sendEmail');

/*
 * RECOMMENDED INDEX (add in models/CustomerProduct.js, after cleaning any duplicate invoice numbers):
 *
 *   customerProductSchema.index(
 *     { 'paymentHistory.invoiceNo': 1 },
 *     {
 *       unique: true,
 *       partialFilterExpression: { 'paymentHistory.invoiceNo': { $type: 'string', $gt: '' } }
 *     }
 *   );
 *
 * ALSO ADD (needed for fast lookups; without it MongoDB scans the whole collection):
 *
 *   customerProductSchema.index({ 'paymentHistory._id': 1 });   // used by PDF / delete / verify by payment id
 *   customerProductSchema.index({ 'paymentHistory.withGst': 1 }); // optional, speeds up GST / non-GST filter
 *
 * Because invoice numbers come from paymentHistory itself (no counter collection), this index is what
 * protects against two people getting the same number at the same moment. Strongly recommended.
 */

// =========================================================================
// CONSTANTS & SMALL HELPERS
// =========================================================================

const MAX_PAGE_SIZE = 100;
const MAX_NUMBER_RETRIES = 5;

// Move these to a DB seed / env config when possible.
const DEFAULT_SETTINGS = {
  companyName: 'Jayam Technologies',
  companyNameWithoutGst: 'Jayam Web Solutions',
  address: '7/1, Thirumazhisai street, Tambaram Sanatorium, Selaiyur, Chennai 600 059.',
  addressWithoutGst: '7/1, Thirumazhisai street, Tambaram Sanatorium, Selaiyur, Chennai 600 059.',
  phone: '9677876445 / 9840599789',
  phoneWithoutGst: '9677876445 / 9840599789',
  email: 'jayamwebsolutions@gmail.com',
  emailWithoutGst: 'jayamwebsolutions@gmail.com',
  gstin: '33AAAAA0000A1Z5',
  cgstPercentage: 9,
  sgstPercentage: 9,
  igstPercentage: 18,
  signatureImage: '',
  bankAccountName: 'JAYAM TECHNOLOGIES',
  bankAccountNumber: '120035000004',
  bankName: 'Canara Bank',
  bankBranch: 'Perungalathur',
  bankIfsc: 'CNRB0003856',
  gpayNumber: '9840599789',
  bankAccountNameWithoutGst: 'Jayam Web Solutions',
  bankAccountNumberWithoutGst: '722473240',
  bankNameWithoutGst: 'Indian Bank',
  bankBranchWithoutGst: 'Tambaram West, Chennai',
  bankIfscWithoutGst: 'IDIB000T092',
  gpayNumberWithoutGst: '9677876445'
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sendError = (res, error, fallbackMessage) => {
  const status = error.status || 500;
  if (status >= 500) console.error(`${fallbackMessage}:`, error);
  return res.status(status).json({
    success: false,
    message: status >= 500 ? fallbackMessage : error.message,
    error: error.message
  });
};

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isWithGstType = (type) => {
  if (typeof type === 'boolean') return type;
  if (!type) return false;
  const s = String(type).trim().toLowerCase();
  return s === 'withgst' || s === 'with_gst' || s === 'gst' || s === 'true' || s === 'yes';
};

const round2 = (n) => Number((Number(n) || 0).toFixed(2));

/** Returns { mm, yyyy } from 'YYYY-MM-DD' strings (timezone safe) or any date value. */
const getMonthYear = (invoiceDate) => {
  if (typeof invoiceDate === 'string') {
    const m = invoiceDate.match(/^(\d{4})-(\d{2})-\d{2}/);
    if (m) return { yyyy: m[1], mm: m[2] };
  }
  const d = invoiceDate ? new Date(invoiceDate) : new Date();
  const valid = isNaN(d.getTime()) ? new Date() : d;
  return {
    yyyy: String(valid.getFullYear()),
    mm: String(valid.getMonth() + 1).padStart(2, '0')
  };
};

const todayString = () => new Date().toISOString().slice(0, 10);

// =========================================================================
// SERVICE LAYER: Settings
// =========================================================================

const SETTINGS_TTL_MS = 60 * 1000;
let settingsCache = { data: null, at: 0 };

// Cached for 1 minute so every PDF does not hit the database for the same settings.
const getGstSettingsData = async () => {
  if (settingsCache.data && Date.now() - settingsCache.at < SETTINGS_TTL_MS) {
    return settingsCache.data;
  }
  const settings = (await GstSetting.findOne().lean()) || { ...DEFAULT_SETTINGS };
  settingsCache = { data: settings, at: Date.now() };
  return settings;
};

// =========================================================================
// SERVICE LAYER: Invoice numbering (from paymentHistory)
// =========================================================================

const getInvoiceMeta = (type, invoiceDate) => {
  const isWithGst = isWithGstType(type);
  const { mm, yyyy } = getMonthYear(invoiceDate);
  const monthYearSuffix = `${mm}-${yyyy}`;
  return {
    isWithGst,
    monthYearSuffix,
    // ^JT001-11-2026   |   ^0001-JWS-11-2026
    regex: isWithGst
      ? new RegExp(`^JT(\\d+)-${monthYearSuffix}$`, 'i')
      : new RegExp(`^(\\d+)-JWS-${monthYearSuffix}$`, 'i')
  };
};

const formatInvoiceNo = (meta, seq) =>
  meta.isWithGst
    ? `JT${String(seq).padStart(3, '0')}-${meta.monthYearSuffix}`
    : `${String(seq).padStart(4, '0')}-JWS-${meta.monthYearSuffix}`;

/**
 * Highest sequence already used in payment history for this series + month.
 * Only invoice numbers of that month are fetched (not the whole collection).
 */
const getMaxSeqFromPayments = async (meta) => {
  const rows = await CustomerProduct.aggregate([
    { $match: { 'paymentHistory.invoiceNo': { $regex: meta.regex } } },
    { $unwind: '$paymentHistory' },
    { $match: { 'paymentHistory.invoiceNo': { $regex: meta.regex } } },
    { $project: { _id: 0, invoiceNo: '$paymentHistory.invoiceNo' } }
  ]);

  let maxSeq = 0;
  for (const row of rows) {
    const match = String(row.invoiceNo).match(meta.regex);
    if (match) maxSeq = Math.max(maxSeq, parseInt(match[1], 10));
  }
  return maxSeq;
};

/**
 * Next number = highest number already stored in paymentHistory (for that series + month) + 1.
 * No separate counter collection: paymentHistory.invoiceNo is the only source of truth.
 */
const getNextInvoiceNumberInternal = async (type, invoiceDate) => {
  const meta = getInvoiceMeta(type, invoiceDate);
  const maxSeq = await getMaxSeqFromPayments(meta);
  const nextSeq = maxSeq + 1;

  return {
    invoiceNo: formatInvoiceNo(meta, nextSeq),
    nextSeq,
    isWithGst: meta.isWithGst,
    monthYearSuffix: meta.monthYearSuffix
  };
};

/**
 * Is this invoice number already used? (optionally ignoring one payment, for edits)
 * $elemMatch makes sure invoiceNo and _id conditions apply to the SAME payment entry.
 */
const verifyInvoiceNumberInternal = async (invoiceNo, excludePaymentId = null) => {
  if (!invoiceNo) return { exists: false };

  const elem = { invoiceNo: String(invoiceNo).trim() };
  if (excludePaymentId && mongoose.Types.ObjectId.isValid(excludePaymentId)) {
    elem._id = { $ne: toObjectId(excludePaymentId) };
  }

  const exists = await CustomerProduct.exists({ paymentHistory: { $elemMatch: elem } });
  return { exists: Boolean(exists) };
};

/**
 * Makes sure a payment has an invoice number and returns it.
 * Only fills it if still empty, so concurrent requests cannot overwrite each other.
 */
const ensureInvoiceNumber = async (product, pay, isWithGst, invoiceDate) => {
  if (pay.invoiceNo) return pay.invoiceNo;

  for (let attempt = 0; attempt < MAX_NUMBER_RETRIES; attempt++) {
    const { invoiceNo } = await getNextInvoiceNumberInternal(isWithGst, invoiceDate);

    try {
      const result = await CustomerProduct.updateOne(
        {
          _id: product._id,
          paymentHistory: {
            $elemMatch: {
              _id: pay._id,
              $or: [{ invoiceNo: { $exists: false } }, { invoiceNo: '' }, { invoiceNo: null }]
            }
          }
        },
        { $set: { 'paymentHistory.$.invoiceNo': invoiceNo } }
      );

      if (result.modifiedCount > 0) return invoiceNo;

      // Someone else stamped this payment in the meantime: use theirs.
      const fresh = await CustomerProduct.findOne(
        { _id: product._id },
        { paymentHistory: { $elemMatch: { _id: pay._id } } }
      ).lean();
      const existing = fresh?.paymentHistory?.[0]?.invoiceNo;
      if (existing) return existing;
    } catch (err) {
      if (err.code === 11000) continue; // someone took this number first (unique index): recalculate and retry
      throw err;
    }
  }

  throw new HttpError(500, 'Could not allocate a unique invoice number, please retry');
};

// =========================================================================
// SERVICE LAYER: Payment records (invoice list) - filtering done inside MongoDB
// =========================================================================

const mapPaymentRow = (row) => {
  const pay = row.paymentHistory;
  const cust = row.customer || {};
  const domain = row.domain || '';
  const isWithGst = Boolean(pay.withGst);

  const custName = cust.companyName || cust.name || row.customerDetails?.name || 'Customer';
  const subtotal = Number(pay.amount) || 0;
  const gstval = Number(pay.gstvalue) || 0;
  const totalPrice = isWithGst ? round2(subtotal + gstval) : subtotal;
  const tdsAmount = Number(pay.tdsAmount) || 0;
  const netAmountReceived = Math.max(0, round2(totalPrice - tdsAmount));

  const services = `${row.product}${row.variant ? ` (${row.variant})` : ''}`;
  const itemDesc = pay.description || `${services} - ${pay.paymentStage || 'Payment'}`;

  return {
    _id: pay._id,
    paymentId: pay._id,
    productId: row._id,
    orderId: row.order?._id || row.orderId,
    // Empty until a real number is generated (no fake preview numbers anymore)
    invoiceNo: pay.invoiceNo || '',
    invoiceGenerated: Boolean(pay.invoiceNo),
    invoiceDate: row.payDate,
    invoiceType: isWithGst ? 'withGST' : 'withoutGST',
    paymentStage: pay.paymentStage || 'full',
    stageNumber: pay.stageNumber || 1,
    subtotal,
    gstvalue: gstval,
    totalPrice,
    tdsAmount,
    netAmountReceived,
    customerName: custName,
    customerId: cust,
    domainUrl: domain,
    services,
    description: pay.description || '',
    items: [
      {
        description: itemDesc,
        domainName: domain,
        rate: subtotal,
        price: subtotal,
        amount: subtotal,
        qty: 1,
        quantity: 1
      }
    ],
    paymentStatus: 'Paid',
    createdAt: pay.createdAt || row.payDate
  };
};

/**
 * Reads CustomerProduct.paymentHistory as invoices.
 * query: customerId, search, type (withGST|withoutGST|all), month, year, page, limit
 * Pagination is optional: without page/limit the full list is returned (old behaviour).
 */
const getPaymentRecords = async (query = {}) => {
  const { customerId, search, type, month, year } = query;

  const paginated = query.page !== undefined || query.limit !== undefined;
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), MAX_PAGE_SIZE);

  const matchProducts = { 'paymentHistory.0': { $exists: true } };
  if (customerId && mongoose.Types.ObjectId.isValid(customerId)) {
    matchProducts.customerId = toObjectId(customerId);
  }

  // Coarse filter on the product (can use an index) before any $lookup; exact filter is applied per payment below.
  if (type && type !== 'all') {
    matchProducts['paymentHistory.withGst'] = isWithGstType(type);
  }

  const pipeline = [
    { $match: matchProducts },
    {
      $lookup: {
        from: Customer.collection.name,
        localField: 'customerId',
        foreignField: '_id',
        as: 'customer'
      }
    },
    {
      $lookup: {
        from: Order.collection.name,
        localField: 'orderId',
        foreignField: '_id',
        as: 'order'
      }
    },
    {
      $addFields: {
        customer: { $arrayElemAt: ['$customer', 0] },
        order: { $arrayElemAt: ['$order', 0] }
      }
    },
    { $unwind: '$paymentHistory' },
    {
      $addFields: {
        // Normalised 'YYYY-MM-DD' (works for string or Date values)
        payDate: {
          $let: {
            vars: { d: { $ifNull: ['$paymentHistory.date', '$paymentHistory.createdAt'] } },
            in: {
              $cond: [
                { $eq: [{ $type: '$$d' }, 'date'] },
                { $dateToString: { format: '%Y-%m-%d', date: '$$d' } },
                { $ifNull: [{ $toString: '$$d' }, ''] }
              ]
            }
          }
        },
        domain: {
          $cond: [
            { $gt: [{ $strLenCP: { $ifNull: ['$domainUrl', ''] } }, 0] },
            '$domainUrl',
            { $ifNull: ['$order.domainUrl', ''] }
          ]
        },
        amountStr: { $toString: { $ifNull: ['$paymentHistory.amount', 0] } }
      }
    },
    {
      $addFields: {
        payMonth: { $substrCP: ['$payDate', 5, 2] },
        payYear: { $substrCP: ['$payDate', 0, 4] }
      }
    }
  ];

  // Skip zero-amount payments that never got an invoice number
  const and = [
    {
      $or: [
        { 'paymentHistory.amount': { $gt: 0 } },
        { 'paymentHistory.invoiceNo': { $exists: true, $nin: ['', null] } }
      ]
    }
  ];

  if (type && type !== 'all') {
    and.push({ 'paymentHistory.withGst': isWithGstType(type) });
  }
  if (month && month !== 'all') and.push({ payMonth: String(month).padStart(2, '0') });
  if (year && year !== 'all') and.push({ payYear: String(year) });

  if (search && String(search).trim()) {
    const rx = { $regex: escapeRegex(String(search).trim()), $options: 'i' };
    and.push({
      $or: [
        { 'paymentHistory.invoiceNo': rx },
        { 'customer.companyName': rx },
        { 'customer.name': rx },
        { 'customerDetails.name': rx },
        { domain: rx },
        { 'paymentHistory.description': rx },
        { product: rx },
        { amountStr: rx }
      ]
    });
  }

  pipeline.push({ $match: { $and: and } });
  pipeline.push({ $sort: { payDate: -1, 'paymentHistory.createdAt': -1, _id: -1 } });

  if (!paginated) {
    const rows = await CustomerProduct.aggregate(pipeline).allowDiskUse(true);
    return { items: rows.map(mapPaymentRow), total: rows.length, page: 1, limit: rows.length };
  }

  pipeline.push({
    $facet: {
      items: [{ $skip: (page - 1) * limit }, { $limit: limit }],
      total: [{ $count: 'count' }]
    }
  });

  const [result] = await CustomerProduct.aggregate(pipeline).allowDiskUse(true);
  return {
    items: (result?.items || []).map(mapPaymentRow),
    total: result?.total?.[0]?.count || 0,
    page,
    limit
  };
};

// =========================================================================
// SERVICE LAYER: PDF generation (shared browser, always cleans up pages)
// =========================================================================

let browserPromise = null;

const getBrowser = () => {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
      .then((browser) => {
        browser.on('disconnected', () => {
          browserPromise = null; // relaunch on next request
        });
        return browser;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
};

/** Call this on server shutdown (SIGTERM/SIGINT handler) if you want a clean exit. */
const closeBrowser = async () => {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch (_) {
    /* ignore */
  } finally {
    browserPromise = null;
  }
};

const renderPdf = async (htmlContent) => {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    await page.evaluateHandle('document.fonts.ready');
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '5mm', right: '5mm', bottom: '5mm', left: '5mm' }
    });
  } finally {
    await page.close().catch(() => {});
  }
};

const buildFilename = (isWithGst, customerName, invoiceNo) => {
  const clean = String(customerName || 'Customer').replace(/[^\w.-]+/g, '');
  const safeNo = String(invoiceNo || '').replace(/[^\w.-]+/g, '');
  return `${isWithGst ? 'TAX-Invoice' : 'Invoice'}-${clean || 'Customer'}-${safeNo}.pdf`;
};

const sendPdf = (res, pdfBuffer, filename) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  return res.send(pdfBuffer);
};

const buildItem = (description, domainName, amount, qty = 1) => ({
  description,
  domainName,
  rate: amount,
  price: amount,
  amount,
  qty,
  quantity: qty
});

const buildInvoiceData = ({
  invoiceNo,
  invoiceDate,
  isWithGst,
  customer = {},
  fallbackCustomerDetails = {},
  totalAmount,
  tdsAmount,
  paymentStage,
  stageNumber,
  isProforma,
  items,
  paymentStatus = 'Paid'
}) => ({
  invoiceNo,
  invoiceDate,
  withGst: isWithGst,
  customerState: customer.state || 'Tamil Nadu',
  customerName: customer.companyName || customer.name || fallbackCustomerDetails.name || 'Customer',
  customerAddress: customer.address || fallbackCustomerDetails.address || '',
  customerGstin: customer.gstin || fallbackCustomerDetails.gstin || '',
  totalAmount,
  tdsAmount,
  paymentStage: paymentStage || 'full',
  stageNumber: stageNumber || 1,
  isProforma: Boolean(isProforma),
  items,
  paymentStatus: paymentStatus || 'Paid'
});

/**
 * Builds invoice data and PDF for one payment history entry.
 * Generates + stores an invoice number (in paymentHistory) the first time.
 */
const processInvoicePdf = async (paymentId) => {
  if (!paymentId || !mongoose.Types.ObjectId.isValid(paymentId)) {
    throw new HttpError(400, 'Valid Payment ID is required');
  }

  const product = await CustomerProduct.findOne({ 'paymentHistory._id': toObjectId(paymentId) })
    .populate('customerId', 'name companyName email phone address state gstin')
    .populate('orderId', 'domainUrl orderDate')
    .lean();

  if (!product) throw new HttpError(404, 'Payment record not found');

  const pay = (product.paymentHistory || []).find((p) => String(p._id) === String(paymentId));
  if (!pay) throw new HttpError(404, 'Payment subdocument not found');

  const isWithGst = Boolean(pay.withGst);
  const invoiceDate = pay.date || todayString();
  const invoiceNo = await ensureInvoiceNumber(product, pay, isWithGst, invoiceDate);

  const customer = product.customerId || {};
  const settings = await getGstSettingsData();
  const domainUrl = product.domainUrl || product.orderId?.domainUrl || '';
  const amount = Number(pay.amount) || 0;
  const services = `${product.product}${product.variant ? ` (${product.variant})` : ''}`;
  const lineDesc =
    pay.description ||
    `${services} - ${pay.paymentStage || 'Service'}${domainUrl ? ` for ${domainUrl}` : ''}`;

  const invoiceData = buildInvoiceData({
    invoiceNo,
    invoiceDate,
    isWithGst,
    customer,
    fallbackCustomerDetails: product.customerDetails || {},
    totalAmount: amount,
    tdsAmount: Number(pay.tdsAmount) || 0,
    paymentStage: pay.paymentStage,
    stageNumber: pay.stageNumber,
    isProforma: false,
    items: [buildItem(lineDesc, domainUrl, amount)],
    paymentStatus: pay.status || 'Paid'
  });

  const pdfBuffer = await renderPdf(generateInvoiceHtml(invoiceData, settings));
  const filename = buildFilename(isWithGst, invoiceData.customerName, invoiceNo);

  return { pdfBuffer, filename, invoiceNo };
};

/**
 * On-the-fly PDF (no payment record yet): from Order / Customer / paymentData.
 * Nothing is written to payment history here. The number is a preview unless
 * customInvoiceNo is supplied.
 */
const processAdHocInvoicePdf = async (body) => {
  const { customerId, orderId, invoiceType, invoiceDate, paymentData, customInvoiceNo, isProforma } = body;

  const isWithGst = isWithGstType(invoiceType || paymentData?.withGst);

  const resolvedCustomer =
    customerId && mongoose.Types.ObjectId.isValid(customerId)
      ? await Customer.findById(customerId).lean()
      : null;

  let resolvedOrder = null;
  let resolvedProducts = [];
  if (orderId && mongoose.Types.ObjectId.isValid(orderId)) {
    [resolvedOrder, resolvedProducts] = await Promise.all([
      Order.findById(orderId).lean(),
      CustomerProduct.find({ orderId }).lean()
    ]);
  }

  const finalInvoiceNo =
    customInvoiceNo || (await getNextInvoiceNumberInternal(isWithGst, invoiceDate)).invoiceNo;

  const domainUrl = resolvedOrder?.domainUrl || resolvedProducts[0]?.domainUrl || '';
  const totalAmount = Number(
    paymentData?.amount ||
      resolvedOrder?.totalPrice ||
      resolvedProducts.reduce((sum, p) => sum + (p.price || 0), 0) ||
      0
  );

  let items;
  if (paymentData?.description) {
    items = [buildItem(paymentData.description, domainUrl, totalAmount)];
  } else if (resolvedProducts.length > 0) {
    items = resolvedProducts.map((p) =>
      buildItem(
        `${p.product}${p.variant ? ` (${p.variant})` : ''}`,
        p.domainUrl || domainUrl,
        p.price || 0,
        p.quantity || 1
      )
    );
  } else {
    items = [buildItem('Web Services & Solutions', domainUrl, totalAmount)];
  }

  const invoiceData = buildInvoiceData({
    invoiceNo: finalInvoiceNo,
    invoiceDate: invoiceDate || todayString(),
    isWithGst,
    customer: resolvedCustomer || {},
    totalAmount,
    tdsAmount: Number(paymentData?.tdsAmount || 0),
    paymentStage: paymentData?.paymentStage,
    stageNumber: paymentData?.stageNumber,
    isProforma,
    items,
    paymentStatus: paymentData?.paymentStatus || 'Paid'
  });

  const settings = await getGstSettingsData();
  const pdfBuffer = await renderPdf(generateInvoiceHtml(invoiceData, settings));
  const filename = buildFilename(isWithGst, invoiceData.customerName, finalInvoiceNo);

  return { pdfBuffer, filename };
};

// =========================================================================
// CONTROLLER LAYER
// =========================================================================

/**
 * GET /invoices
 * Query: customerId, search, type, month, year, page, limit
 * - without page/limit  -> plain array (same as before)
 * - with page or limit  -> { data, pagination }
 */
const getInvoices = async (req, res) => {
  try {
    const { items, total, page, limit } = await getPaymentRecords(req.query);

    const paginated = req.query.page !== undefined || req.query.limit !== undefined;
    if (!paginated) return res.json(items);

    return res.json({
      data: items,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
    });
  } catch (error) {
    return sendError(res, error, 'Failed to fetch invoices');
  }
};

/**
 * GET /invoices/:id/pdf
 */
const getInvoicePdf = async (req, res) => {
  try {
    const { pdfBuffer, filename } = await processInvoicePdf(req.params.id);
    return sendPdf(res, pdfBuffer, filename);
  } catch (error) {
    return sendError(res, error, 'Failed to generate invoice PDF');
  }
};

/**
 * GET /invoices/next-number
 * Preview of the next number (does not reserve it).
 */
const getNextInvoiceNumber = async (req, res) => {
  try {
    const rawType = req.query.invoiceType || req.query.gstType || req.query.type;
    const invoiceDate = req.query.invoiceDate || req.query.date;
    const data = await getNextInvoiceNumberInternal(rawType, invoiceDate);
    return res.json(data);
  } catch (error) {
    return sendError(res, error, 'Failed to predict next invoice number');
  }
};

/**
 * GET /invoices/verify-number
 */
const verifyInvoiceNumber = async (req, res) => {
  try {
    const { invoiceNo, paymentId } = req.query;
    const data = await verifyInvoiceNumberInternal(invoiceNo, paymentId);
    return res.json(data);
  } catch (error) {
    return sendError(res, error, 'Failed to verify invoice number');
  }
};

/**
 * POST /invoices/generate
 * - with paymentId: uses that payment (optionally sets customInvoiceNo after a duplicate check)
 * - without paymentId: builds the PDF on the fly from customer / order / paymentData
 */
const generateInvoicePdf = async (req, res) => {
  try {
    const { paymentId, customInvoiceNo } = req.body || {};

    // Case A: existing payment record
    if (paymentId && mongoose.Types.ObjectId.isValid(paymentId)) {
      if (customInvoiceNo && String(customInvoiceNo).trim()) {
        const trimmed = String(customInvoiceNo).trim();

        const { exists } = await verifyInvoiceNumberInternal(trimmed, paymentId);
        if (exists) throw new HttpError(409, `Invoice number ${trimmed} is already used`);

        const result = await CustomerProduct.updateOne(
          { 'paymentHistory._id': toObjectId(paymentId) },
          { $set: { 'paymentHistory.$.invoiceNo': trimmed } }
        );
        if (result.matchedCount === 0) throw new HttpError(404, 'Payment record not found');
      }

      const { pdfBuffer, filename } = await processInvoicePdf(paymentId);
      return sendPdf(res, pdfBuffer, filename);
    }

    // Case B: on-the-fly
    const { pdfBuffer, filename } = await processAdHocInvoicePdf(req.body || {});
    return sendPdf(res, pdfBuffer, filename);
  } catch (error) {
    return sendError(res, error, 'Failed to generate invoice PDF');
  }
};

/**
 * POST /invoices/:id/email
 * Sends invoice PDF directly to customer via email
 */
const emailInvoice = async (req, res) => {
  try {
    const paymentId = req.params.id;
    if (!paymentId || !mongoose.Types.ObjectId.isValid(paymentId)) {
      throw new HttpError(400, 'Valid Payment ID is required');
    }

    const { pdfBuffer, filename, invoiceNo } = await processInvoicePdf(paymentId);

    const product = await CustomerProduct.findOne({ 'paymentHistory._id': toObjectId(paymentId) })
      .populate('customerId', 'name companyName email')
      .populate('orderId', 'domainUrl')
      .lean();

    if (!product) throw new HttpError(404, 'Payment product record not found');

    const customer = product.customerId || {};
    const recipientEmail = req.body?.email || customer.email;

    if (!recipientEmail) {
      throw new HttpError(400, 'Customer has no email address configured');
    }

    const domain = product.domainUrl || product.orderId?.domainUrl || '';
    const subject =
      req.body?.subject ||
      `Invoice ${invoiceNo} from Jayam Web Solutions${domain ? ` for ${domain}` : ''}`;
    const text =
      req.body?.message ||
      `Dear ${customer.name || customer.companyName || 'Valued Customer'},\n\nPlease find attached your invoice (${invoiceNo}).\n\nThank you for your business!\nJayam Web Solutions`;

    await sendEmail({
      email: recipientEmail,
      subject,
      message: text.replace(/\n/g, '<br/>'),
      text,
      attachments: [{ filename, content: pdfBuffer }]
    });

    return res.json({
      success: true,
      message: `Invoice ${invoiceNo} emailed successfully to ${recipientEmail}`
    });
  } catch (error) {
    return sendError(res, error, 'Failed to email invoice');
  }
};

module.exports = {
  getInvoices,
  getInvoicePdf,
  getNextInvoiceNumber,
  verifyInvoiceNumber,
  generateInvoicePdf,
  emailInvoice,
  closeBrowser
};