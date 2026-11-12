const express = require('express');
const router = express.Router();
const { getSettings, saveSettings, triggerCron } = require('../controllers/autoReminderController');
const { protect } = require('../middleware/authMiddleware');

router.get('/settings', protect, getSettings);
router.post('/settings', protect, saveSettings);
router.post('/run', protect, triggerCron);

module.exports = router;
