const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  getInvoices,
  getInvoicePdf,
  getNextInvoiceNumber,
  verifyInvoiceNumber,
  generateInvoicePdf,
  emailInvoice
} = require('../controllers/invoiceController');

// All invoice routes protected by authMiddleware
router.use(protect);

// GET /api/invoices -> Request Invoice List (from Payment History)
router.get('/', getInvoices);

// GET /api/invoices/next-number -> Predict next sequential invoice number
router.get('/next-number', getNextInvoiceNumber);

// GET /api/invoices/verify-number -> Verify if invoice number is already assigned
router.get('/verify-number', verifyInvoiceNumber);

// GET /api/invoices/:id/pdf -> Request Invoice PDF by Payment ID (download / preview)
router.get('/:id/pdf', getInvoicePdf);

// POST /api/invoices/generate -> Process and stream Invoice PDF
router.post('/generate', generateInvoicePdf);

// POST /api/invoices/:id/email -> Send Invoice PDF to customer via email
router.post('/:id/email', emailInvoice);

module.exports = router;

