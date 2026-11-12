const express = require('express');
const router = express.Router();
const { getSmtpSettings, updateSmtpSettings } = require('../controllers/smtpController');
const { protect } = require('../middleware/authMiddleware');

router.route('/')
    .get(protect, getSmtpSettings)
    .put(protect, updateSmtpSettings);

module.exports = router;
