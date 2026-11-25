const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// Secure authentication middleware
const { protect } = require('../middleware/authMiddleware');

// Controllers
const renewalController = require('../controllers/renewalController');
const ReminderController = require('../controllers/ReminderController');

// ── Security & Validation Middleware ─────────────────────────────────
const validateObjectId = (paramName = 'id') => (req, res, next) => {
  const id = req.params[paramName] || req.body[paramName];
  if (id && !mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({
      success: false,
      message: `Invalid identifier format for '${paramName}'`,
    });
  }
  next();
};

// All renewal routes are protected behind JWT authentication
router.use(protect);

// ── Renewal Query & Planning Endpoints ─────────────────────────────────
// 1. Fetch renewals with PAID/UNPAID segregation, auto-status update, filters & pagination
router.get('/', renewalController.getRenewals);

// 2. Fetch renewal pipeline plan & statistics
router.get('/plan', renewalController.getRenewalPlan);

// 3. Export renewals data to Excel
router.get('/export', renewalController.exportRenewals);

// ── Renewal Execution & Status Updates ────────────────────────────────
// 4. Update renewal status ('upcoming', 'renewed', 'not_renewal')
router.patch('/:id/status', validateObjectId('id'), renewalController.updateRenewalStatus);

// 5. Execute renewal (advances dates, marks 'renewed', clears reminder)
router.post('/:id/renew', validateObjectId('id'), renewalController.executeRenewal);

module.exports = router;

