const puppeteer = require('puppeteer');
const Proforma = require('../models/Proforma');
const Invoice = require('../models/Invoice');
const GstSetting = require('../models/GstSetting');
const { generateProformaHtml } = require('../templates/proformaTemplate');

// Helper to fetch GST settings from DB
const getGstSettingsData = async () => {
  let settings = await GstSetting.findOne();
  if (!settings) {
    settings = {
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
      gpayNumberWithoutGst: '9677876445'
    };
  }
  return settings;
};

/**
 * Get all proformas
 */
const getProformas = async (req, res) => {
  try {
    const proformas = await Proforma.find().populate('customerId').sort({ createdAt: -1 });
    res.json(proformas);
  } catch (error) {
    console.error('Error fetching proformas:', error);
    res.status(500).json({ message: 'Failed to fetch proformas', error: error.message });
  }
};

/**
 * Helper to check if a GST type indicates withGST
 */
const isWithGstType = (type) => {
  if (!type) return false;
  const s = String(type).trim().toLowerCase();
  return s === 'withgst' || s === 'with_gst' || s === 'gst' || s === 'true';
};

/**
 * Generate next proforma number by inspecting existing proformas in DB.
 * - withGST: prefix "JT-PI-", sequence starting from 01 (e.g. JT-PI-01, JT-PI-02...)
 * - withoutGST: prefix "JWS-PI-", sequence starting from 01 (e.g. JWS-PI-01, JWS-PI-02...)
 * Continues based on the highest existing invoice number in the database for each type.
 */
const generateNextProformaNumber = async (type) => {
  const isWithGst = isWithGstType(type);
  const prefix = isWithGst ? 'JT-PI-' : 'JWS-PI-';
  const regex = isWithGst ? /^JT-?PI-?(\d+)/i : /^JWS-?PI-?(\d+)/i;

  const proformas = await Proforma.find();
  let maxSeq = 0;

  for (const item of proformas) {
    if (!item.proforma_no) continue;
    const match = item.proforma_no.match(regex);
    if (match) {
      const seq = parseInt(match[1], 10);
      if (seq > maxSeq) {
        maxSeq = seq;
      }
    }
  }

  let nextSeq = maxSeq + 1;
  let proformaNo = `${prefix}${String(nextSeq).padStart(2, '0')}`;
  while (await Proforma.findOne({ proforma_no: proformaNo })) {
    nextSeq++;
    proformaNo = `${prefix}${String(nextSeq).padStart(2, '0')}`;
  }

  return { proformaNo, nextSeq, prefix, isWithGst };
};

/**
 * Get next proforma number (last proforma number + 1)
 */
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

/**
 * Create a new proforma record
 */
const createProforma = async (req, res) => {
  try {
    const payload = req.body;

    // Auto generate proforma_no if not provided
    if (!payload.proforma_no) {
      const type = payload.gstType || (payload.isWithGst ? 'withGST' : 'withoutGST');
      const { proformaNo } = await generateNextProformaNumber(type);
      payload.proforma_no = proformaNo;
    } else {
      const existing = await Proforma.findOne({ proforma_no: payload.proforma_no.trim() });
      if (existing) {
        return res.status(400).json({
          message: `Proforma number "${payload.proforma_no}" is already in use by another proforma invoice. Please enter a different proforma number.`
        });
      }
    }

    const newProforma = new Proforma(payload);
    const saved = await newProforma.save();
    res.status(201).json(saved);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        message: `Proforma number "${req.body.proforma_no || 'specified'}" is already in use by another proforma invoice.`
      });
    }
    console.error('Error creating proforma:', error);
    res.status(500).json({ message: 'Failed to create proforma', error: error.message });
  }
};

/**
 * Update an existing proforma record
 */
const updateProforma = async (req, res) => {
  try {
    const { id } = req.params;
    const payload = req.body;

    const mongoose = require('mongoose');
    let existingDoc = null;

    if (id && mongoose.Types.ObjectId.isValid(id)) {
      existingDoc = await Proforma.findById(id);
    }
    if (!existingDoc && id) {
      existingDoc = await Proforma.findOne({ proforma_no: id });
    }

    if (!existingDoc) {
      return res.status(404).json({ message: 'Proforma not found' });
    }

    if (payload.proforma_no && payload.proforma_no !== existingDoc.proforma_no) {
      const dupCheck = await Proforma.findOne({
        proforma_no: payload.proforma_no.trim(),
        _id: { $ne: existingDoc._id }
      });
      if (dupCheck) {
        return res.status(400).json({
          message: `Proforma number "${payload.proforma_no}" is already in use by another proforma invoice. Please enter a different proforma number.`
        });
      }
    }

    Object.assign(existingDoc, payload);
    const updated = await existingDoc.save();
    res.json(updated);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        message: `Proforma number "${req.body.proforma_no || 'specified'}" is already in use by another proforma invoice.`
      });
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
    const deleted = await Proforma.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ message: 'Proforma not found' });
    }
    res.json({ message: 'Proforma deleted successfully' });
  } catch (error) {
    console.error('Error deleting proforma:', error);
    res.status(500).json({ message: 'Failed to delete proforma', error: error.message });
  }
};

/**
 * Generate PDF proforma invoice
 */
const generateProformaPdf = async (req, res) => {
  try {
    const proformaData = req.body;
    const settings = await getGstSettingsData();
    const htmlContent = generateProformaHtml(proformaData, settings);

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    await page.evaluateHandle('document.fonts.ready');

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '5mm',
        right: '5mm',
        bottom: '5mm',
        left: '5mm'
      }
    });

    await browser.close();

    const cleanCompany = (proformaData.customerId?.name || proformaData.companyName || 'Customer').replace(/[\s\/\\]+/g, '');
    const proformaNo = proformaData.proforma_no || 'Proforma';
    const filename = `PROFORMA-Invoice-${cleanCompany}-${proformaNo}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('Error generating proforma PDF:', error);
    res.status(500).json({ message: 'Failed to generate proforma PDF', error: error.message });
  }
};

/**
 * Convert Proforma to Tax Invoice
 */
const convertToInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    const proforma = await Proforma.findById(id);
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
  convertToInvoice
};
