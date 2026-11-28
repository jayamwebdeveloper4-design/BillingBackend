const mongoose = require('mongoose');
const puppeteer = require('puppeteer');
const Proforma = require('../models/Proforma');
const GstSetting = require('../models/GstSetting');
const { generateProformaHtml } = require('../templates/proformaTemplate');

// ── GST settings (cached 60s, lean) ─────────────────────────────────────────
const DEFAULT_GST_SETTINGS = {
  companyName: 'Jayam Web Solutions',
  address: '7/1, Thirumazhisai street, Tambaram Sanatorium, Selaiyur, Chennai 600 059.',
  phone: '9677876445 / 9840599789',
  email: 'jayamwebsolutions@gmail.com',
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
  gpayNumberWithoutGst: '9677876445',
};

const GST_CACHE_TTL_MS = 60 * 1000;
let gstCache = { data: null, at: 0 };

// Call this from the GST settings update controller so changes show immediately
const clearGstCache = () => {
  gstCache = { data: null, at: 0 };
};

const getGstSettingsData = async () => {
  if (gstCache.data && Date.now() - gstCache.at < GST_CACHE_TTL_MS) {
    return gstCache.data;
  }
  const settings = (await GstSetting.findOne().lean()) || DEFAULT_GST_SETTINGS;
  gstCache = { data: settings, at: Date.now() };
  return settings;
};

// ── Puppeteer: ONE shared browser, new page per request ─────────────────────
let browserPromise = null;

const getBrowser = () => {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
      .then((browser) => {
        browser.on('disconnected', () => {
          browserPromise = null; // crashed / closed -> relaunch on next request
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
process.once('SIGINT', closeBrowser);
process.once('SIGTERM', closeBrowser);

const CUSTOMER_FIELDS = 'name phone email gstin address contactPerson state country';

/**
 * Get all proformas
 * - No page/limit query  -> plain array (frontend breaks aagaadhu)
 * - ?page=1&limit=20     -> { data, page, limit, total, totalPages }
 */
const getProformas = async (req, res) => {
  try {
    const rawSearch = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const filter = {};

    if (rawSearch) {
      const escaped = rawSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      const orConditions = [
        { proforma_no: regex },
        { companyName: regex },
        { email: regex },
        { 'items.Particulars': regex },
      ];
      const numericSearch = Number(rawSearch);
      if (!Number.isNaN(numericSearch)) {
        orConditions.push({ totalPrice: numericSearch });
      }
      filter.$or = orConditions;
    }

    const base = () =>
      Proforma.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .populate({ path: 'customerId', select: CUSTOMER_FIELDS })
        .lean();

    if (!req.query.page && !req.query.limit) {
      return res.json(await base());
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const [data, total] = await Promise.all([
      base().skip((page - 1) * limit).limit(limit),
      rawSearch ? Proforma.countDocuments(filter) : Proforma.estimatedDocumentCount(),
    ]);

    res.json({ data, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (error) {
    console.error('Error fetching proformas:', error);
    res.status(500).json({ message: 'Failed to fetch proformas', error: error.message });
  }
};

const isWithGstType = (type) => {
  if (!type) return false;
  const s = String(type).trim().toLowerCase();
  return s === 'withgst' || s === 'with_gst' || s === 'gst' || s === 'true';
};

/**
 * Next proforma number, calculated fully inside MongoDB (no documents loaded).
 * withGST    -> JT-PI-01, JT-PI-02 ...
 * withoutGST -> JWS-PI-01, JWS-PI-02 ...
 * Uniqueness is guaranteed by the unique index (create retries on collision).
 */
const generateNextProformaNumber = async (type) => {
  const isWithGst = isWithGstType(type);
  const prefix = isWithGst ? 'JT-PI-' : 'JWS-PI-';
  const pattern = isWithGst ? '^JT-?PI-?(\\d+)' : '^JWS-?PI-?(\\d+)';

  const [result] = await Proforma.aggregate([
    { $match: { proforma_no: { $regex: pattern, $options: 'i' } } },
    {
      $project: {
        seq: {
          $convert: {
            input: {
              $arrayElemAt: [
                { $ifNull: [{ $regexFind: { input: '$proforma_no', regex: pattern, options: 'i' } }, { captures: ['0'] }] }.captures,
                0,
              ],
            },
            to: 'long',
            onError: 0,
            onNull: 0,
          },
        },
      },
    },
    { $group: { _id: null, maxSeq: { $max: '$seq' } } },
  ]);

  const nextSeq = (result?.maxSeq || 0) + 1;
  const proformaNo = `${prefix}${String(nextSeq).padStart(2, '0')}`;
  return { proformaNo, nextSeq, prefix, isWithGst };
};

const getNextProformaNumber = async (req, res) => {
  try {
    const rawType = req.query.invoiceType || req.query.gstType || req.query.type;
    const { proformaNo, nextSeq, prefix, isWithGst } = await generateNextProformaNumber(rawType);
    res.json({ proformaNo, nextSeq, prefix, gstType: isWithGst ? 'withGST' : 'withoutGST' });
  } catch (error) {
    console.error('Error predicting next proforma number:', error);
    res.status(500).json({ message: 'Failed to get next proforma number', error: error.message });
  }
};

const dupMessage = (no) =>
  `Proforma number "${no || 'specified'}" is already in use by another proforma invoice. Please enter a different proforma number.`;

/**
 * Create a new proforma record
 * Duplicate check = unique index (no extra findOne). Auto numbers retry on race.
 */
const createProforma = async (req, res) => {
  try {
    const payload = { ...req.body };
    const provided = typeof payload.proforma_no === 'string' ? payload.proforma_no.trim() : '';
    const autoGenerate = !provided;
    const type = payload.gstType || (payload.isWithGst ? 'withGST' : 'withoutGST');

    if (!autoGenerate) payload.proforma_no = provided;

    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (autoGenerate) {
        payload.proforma_no = (await generateNextProformaNumber(type)).proformaNo;
      }
      try {
        const saved = await new Proforma(payload).save();
        return res.status(201).json(saved);
      } catch (err) {
        // Two users created at the same moment -> regenerate and retry
        if (err.code === 11000 && autoGenerate && attempt < MAX_ATTEMPTS) continue;
        throw err;
      }
    }
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: dupMessage(req.body.proforma_no) });
    }
    console.error('Error creating proforma:', error);
    res.status(500).json({ message: 'Failed to create proforma', error: error.message });
  }
};

/**
 * Update an existing proforma record (1 find + 1 save)
 */
const updateProforma = async (req, res) => {
  try {
    const { id } = req.params;
    const payload = { ...req.body };
    delete payload._id;
    delete payload.__v;
    if (typeof payload.proforma_no === 'string') payload.proforma_no = payload.proforma_no.trim();

    const query = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ _id: id }, { proforma_no: id }] }
      : { proforma_no: id };

    const existingDoc = await Proforma.findOne(query);
    if (!existingDoc) {
      return res.status(404).json({ message: 'Proforma not found' });
    }

    Object.assign(existingDoc, payload);
    const updated = await existingDoc.save(); // duplicate -> unique index (11000)
    res.json(updated);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: dupMessage(req.body.proforma_no) });
    }
    console.error('Error updating proforma:', error);
    res.status(500).json({ message: 'Failed to update proforma', error: error.message });
  }
};

/**
 * Delete a proforma record
 */
const deleteProforma = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid proforma id' });
    }
    const result = await Proforma.deleteOne({ _id: id });
    if (!result.deletedCount) {
      return res.status(404).json({ message: 'Proforma not found' });
    }
    res.json({ message: 'Proforma deleted successfully' });
  } catch (error) {
    console.error('Error deleting proforma:', error);
    res.status(500).json({ message: 'Failed to delete proforma', error: error.message });
  }
};

/**
 * Generate PDF proforma invoice (shared browser, page always closed)
 */
const generateProformaPdf = async (req, res) => {
  let page;
  try {
    const proformaData = req.body;
    const settings = await getGstSettingsData();
    const htmlContent = generateProformaHtml(proformaData, settings);

    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'load' });
    await page.evaluateHandle('document.fonts.ready');

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '5mm', right: '5mm', bottom: '5mm', left: '5mm' },
    });

    const cleanCompany = (proformaData.customerId?.name || proformaData.companyName || 'Customer').replace(/[\s\/\\]+/g, '');
    const proformaNo = proformaData.proforma_no || 'Proforma';
    const filename = `PROFORMA-Invoice-${cleanCompany}-${proformaNo}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(Buffer.from(pdfBuffer));
  } catch (error) {
    console.error('Error generating proforma PDF:', error);
    res.status(500).json({ message: 'Failed to generate proforma PDF', error: error.message });
  } finally {
    if (page) await page.close().catch(() => {});
  }
};

/**
 * Convert Proforma to Tax Invoice
 */
const convertToInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid proforma id' });
    }
    const proforma = await Proforma.findById(id).lean();
    if (!proforma) {
      return res.status(404).json({ message: 'Proforma not found' });
    }
    res.json({ message: 'Proforma converted to invoice successfully', proforma });
  } catch (error) {
    console.error('Error converting proforma:', error);
    res.status(500).json({ message: 'Failed to convert proforma', error: error.message });
  }
};

module.exports = {
  getProformas,
  getNextProformaNumber,
  createProforma,
  updateProforma,
  deleteProforma,
  generateProformaPdf,
  convertToInvoice,
  clearGstCache,
};