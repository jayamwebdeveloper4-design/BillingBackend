const express = require('express');
const router = express.Router();
const { generateInvoice, getInvoices, verifyInvoiceNumber, getNextInvoiceNumber, deleteInvoice } = require('../controllers/invoiceController');
const { protect } = require('../middleware/authMiddleware');

// GET  /api/invoices              -> list all invoices
router.get('/', protect, getInvoices);

// GET  /api/invoices/next-number  -> get predicted next invoice number
router.get('/next-number', protect, getNextInvoiceNumber);
router.get('/next-invoice-number', protect, getNextInvoiceNumber);

// GET  /api/invoices/verify-number -> check if invoice number exists
router.get('/verify-number', protect, verifyInvoiceNumber);

// POST /api/invoices/generate     -> create/find invoice record, generate PDF
router.post('/generate', protect, generateInvoice);

// DELETE /api/invoices/:id        -> delete invoice record
router.delete('/:id', protect, deleteInvoice);

module.exports = router;
