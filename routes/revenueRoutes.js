const express = require('express');
const router = express.Router();
const { getRevenueOrders } = require('../controllers/Revenue/revenueController');
const { protect } = require('../middleware/authMiddleware');

// Revenue orders (aggregated from customer products, orders & payments)
router.get('/', protect, getRevenueOrders);

module.exports = router;
