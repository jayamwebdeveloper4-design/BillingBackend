const express = require('express');
const router = express.Router();
const {
  getRevenueOrders,
  getExpressEntries,
  addExpressEntry,
  deleteExpressEntry,
} = require('../controllers/revenueController');
const { protect } = require('../middleware/authMiddleware');

// Revenue orders (aggregated from customer orders)
router.get('/orders', protect, getRevenueOrders);

// Express entries
router.get('/express', protect, getExpressEntries);
router.post('/express', protect, addExpressEntry);
router.delete('/express/:id', protect, deleteExpressEntry);

module.exports = router;
