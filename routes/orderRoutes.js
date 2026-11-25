const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  createOrder,
  getOrders,
  getOrderById,
  updateOrder,
  deleteOrder,
  getOrdersByCustomer,
  recordOrderPayment,
  deleteOrderPayment,

} = require('../controllers/Order');

// Order Management stats & renewal data
// router.get('/management', protect, getOrderManagementData);

// Orders by customer ID
router.get('/customer/:customerId', protect, getOrdersByCustomer);

// Payment operations on specific order
router.post('/:id/payments', protect, recordOrderPayment);
router.delete('/:id/payments/:paymentId', protect, deleteOrderPayment);

// Standard Order CRUD
router.route('/')
  .get(protect, getOrders)
  .post(protect, createOrder);

router.route('/:id')
  .get(protect, getOrderById)
  .put(protect, updateOrder)
  .delete(protect, deleteOrder);

module.exports = router;

