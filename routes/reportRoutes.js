const express = require('express');
const router = express.Router();
const { getReportData } = require('../controllers/Report/reportController');
const { protect } = require('../middleware/authMiddleware');

// Report analytics & tabular insights (customers, orders, active/deactive domains)
router.get('/', protect, getReportData);

module.exports = router;

