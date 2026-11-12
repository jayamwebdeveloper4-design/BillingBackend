const express = require('express');
const router = express.Router();
const { getOrderManagementData } = require('../controllers/orderManagementController');
const { protect } = require('../middleware/authMiddleware');

router.get('/', protect, getOrderManagementData);

module.exports = router;
