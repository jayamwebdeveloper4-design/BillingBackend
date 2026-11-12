const express = require('express');
const router = express.Router();
const {
  getProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  addSubCategory,
  updateSubCategory,
  deleteSubCategory,
} = require('../controllers/productController');
const { protect } = require('../middleware/authMiddleware');

router.route('/')
  .get(protect, getProducts)
  .post(protect, createProduct);

router.route('/:id')
  .put(protect, updateProduct)
  .delete(protect, deleteProduct);

router.route('/:categoryId/subcategories')
  .post(protect, addSubCategory);

router.route('/:categoryId/subcategories/:subCategoryId')
  .put(protect, updateSubCategory)
  .delete(protect, deleteSubCategory);

module.exports = router;

