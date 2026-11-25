const express = require('express');
const router = express.Router();
const { getSmtpSettings, updateSmtpSettings, testSmtpConnection } = require('../controllers/smtpController');
const { protect } = require('../middleware/authMiddleware');

router.route('/')
    .get(protect, getSmtpSettings)
    .put(protect, updateSmtpSettings);

router.post('/test', protect, testSmtpConnection);

module.exports = router;
