const express = require('express');
const router = express.Router();
const {
  getProformas,
  getNextProformaNumber,
  createProforma,
  updateProforma,
  deleteProforma,
  generateProformaPdf,
  convertToInvoice
} = require('../controllers/proformaController');
const { protect } = require('../middleware/authMiddleware');

// GET /api/proformas -> List all proformas
router.get('/', protect, getProformas);

// GET /api/proformas/next-number -> Predict next proforma number
router.get('/next-number', protect, getNextProformaNumber);

// POST /api/proformas -> Create a new proforma
router.post('/', protect, createProforma);

// PUT /api/proformas/:id -> Update proforma
router.put('/:id', protect, updateProforma);

// DELETE /api/proformas/:id -> Delete proforma
router.delete('/:id', protect, deleteProforma);

// POST /api/proformas/generate -> Generate PDF proforma invoice
router.post('/generate', protect, generateProformaPdf);

// POST /api/proformas/:id/convert -> Convert proforma to invoice
router.post('/:id/convert', protect, convertToInvoice);

module.exports = router;