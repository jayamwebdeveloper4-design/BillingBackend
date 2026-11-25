const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { protect } = require('../middleware/authMiddleware');
const ReminderController = require('../controllers/ReminderController');

// ── ID Validation Middleware ──────────────────────────────────────────
const validateObjectId = (paramName = 'id') => (req, res, next) => {
  const id = req.params[paramName] || req.body[paramName] || req.body.productId || req.body.reminderId;
  if (id && !mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({
      success: false,
      message: `Invalid identifier format for '${paramName}'`,
    });
  }
  next();
};

// All reminder endpoints require authentication
router.use(protect);

// ── Dedicated Reminder Routes ─────────────────────────────────────────

// 1. Send single reminder: POST /api/reminders/:id, POST /api/reminders/:id/reminder, POST /api/reminders/:id/send
router.post('/send-email', validateObjectId('productId'), ReminderController.sendRenewalReminder);
router.post('/:id/reminder', validateObjectId('id'), ReminderController.sendRenewalReminder);
router.post('/:id/send', validateObjectId('id'), ReminderController.sendRenewalReminder);
router.post('/:id', validateObjectId('id'), ReminderController.sendRenewalReminder);

// 2. Check eligibility: GET /api/reminders/:id/status
router.get('/:id/status', validateObjectId('id'), ReminderController.getReminderEligibility);
router.get('/:id/reminder-status', validateObjectId('id'), ReminderController.getReminderEligibility);

// 3. Bulk dispatch: POST /api/reminders/bulk
router.post('/bulk', ReminderController.bulkSendReminders);
router.post('/send-bulk', ReminderController.bulkSendReminders);

module.exports = router;

