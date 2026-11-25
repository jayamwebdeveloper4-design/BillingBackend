const express = require('express');
const router = express.Router();
const c = require('../controllers/CustomerProductcontroll');

const { protect } = require('../middleware/authMiddleware');

router.use(protect);
router.get('/grouped', c.getGroupedByOrder);
router.get('/renewals', c.getRenewals);

router.route('/order/:orderId')
  .get(c.getOrderProducts)
  .delete(c.deleteOrderProducts);

router.route('/')
  .get(c.getProducts)
  .post(c.createOrderProducts);

router.patch('/:id/deactivate', c.setDeactive);
router.post('/:id/payments', c.addPayment);
router.route('/:id/payments/:paymentId')
  .put(c.updatePayment)
  .delete(c.deletePayment);

router.route('/:id')
  .get(c.getProductById)
  .put(c.updateProduct)
  .delete(c.deleteProduct);

module.exports = router;