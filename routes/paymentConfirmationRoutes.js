const express = require('express');
const router = express.Router();
const { getSettings, saveSettings, sendPaymentConfirmationManual } = require('../controllers/paymentConfirmationController');
const { protect } = require('../middleware/authMiddleware');

router.route('/settings')
  .get(protect, getSettings)
  .post(protect, saveSettings);

router.post('/send-manual', protect, sendPaymentConfirmationManual);

module.exports = router;
