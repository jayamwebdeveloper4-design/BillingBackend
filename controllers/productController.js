const Product = require('../models/Product');
const { logActivity } = require('../utils/logger');

// @desc    Get all products
// @route   GET /api/products
// @access  Private
const getProducts = async (req, res) => {
  try {
    const products = await Product.find({}).sort({ createdAt: -1 });
    res.json(products);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create a product
// @route   POST /api/products
// @access  Private
const createProduct = async (req, res) => {
  try {
    const { name, subCategories } = req.body;

    const product = new Product({
      name,
      subCategories: subCategories || [],
     
    });
    
    const createdProduct = await product.save();
    
    if (req.admin && req.admin.email) {
      logActivity(req.admin.email, 'PRODUCT', 'SUCCESS', `Created product: ${createdProduct.name}`);
    }

    res.status(201).json(createdProduct);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Update a product
// @route   PUT /api/products/:id
// @access  Private
const updateProduct = async (req, res) => {
  try {
    const { name, subCategories } = req.body;
    const updateData = {};
    if (name) updateData.name = name;
    if (subCategories !== undefined) updateData.subCategories = subCategories;

    const updatedProduct = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: updateData },
      { new: true, runValidators: false }
    );

    if (updatedProduct) {
      if (req.admin && req.admin.email) {
        logActivity(req.admin.email, 'PRODUCT', 'UPDATE', `Updated product: ${updatedProduct.name}`);
      }

      res.json(updatedProduct);
    } else {
      res.status(404).json({ message: 'Product not found' });
    }
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Delete a product
// @route   DELETE /api/products/:id
// @access  Private
const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (product) {
      const productName = product.name;
      await product.deleteOne();
      
      if (req.admin && req.admin.email) {
        logActivity(req.admin.email, 'PRODUCT', 'DELETE', `Deleted product: ${productName}`);
      }

      res.json({ message: 'Product removed' });
    } else {
      res.status(404).json({ message: 'Product not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Add sub-category to category
// @route   POST /api/products/:categoryId/subcategories
// @access  Private
const addSubCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;

    const {
      name,
      oneTimePayment,
      hasPlan,
      hasRenewal,
      costPrice,
      costPriceRenewal,
      sellerPrice,
      sellerPriceRenewal,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        message: 'Sub-category name is required',
      });
    }

    const product = await Product.findById(categoryId);

    if (!product) {
      return res.status(404).json({
        message: 'Category not found',
      });
    }

    // Duplicate name check within the same category
    const isDuplicate = product.subCategories.some(
      (sc) => sc.name.toLowerCase() === name.trim().toLowerCase()
    );

    if (isDuplicate) {
      return res.status(400).json({
        message: 'Sub-category with this name already exists',
      });
    }

    const isOneTimePayment = oneTimePayment === true;

    const newSubCategory = {
      name: name.trim(),
      oneTimePayment: isOneTimePayment,
      hasPlan: isOneTimePayment ? false : !!hasPlan,
      hasRenewal: isOneTimePayment ? false : hasRenewal !== false,
      costPrice: !isOneTimePayment && !hasPlan ? Number(costPrice) || 0 : null,
      sellerPrice: !isOneTimePayment && !hasPlan ? Number(sellerPrice) || 0 : null,
    };

    if (!isOneTimePayment && hasPlan) {
      newSubCategory.plans = [];
    }

    // Add renewal prices only when applicable
    if (
      !isOneTimePayment &&
      !hasPlan &&
      hasRenewal !== false
    ) {
      newSubCategory.costPriceRenewal = Number(costPriceRenewal) || 0;
      newSubCategory.sellerPriceRenewal = Number(sellerPriceRenewal) || 0;
    }

    product.subCategories.push(newSubCategory);

    await product.save();

    const createdSubCategory =
      product.subCategories[product.subCategories.length - 1];

    if (req.admin?.email) {
      logActivity(
        req.admin.email,
        'SUBCATEGORY',
        'SUCCESS',
        `Added sub-category: ${createdSubCategory.name} to ${product.name}`
      );
    }

    res.status(201).json(createdSubCategory);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

// @desc    Update sub-category
// @route   PUT /api/products/:categoryId/subcategories/:subCategoryId
// @access  Private
const updateSubCategory = async (req, res) => {
  try {
    const { categoryId, subCategoryId } = req.params;

    const {
      name,
      oneTimePayment,
      hasPlan,
      hasRenewal,
      costPrice,
      costPriceRenewal,
      sellerPrice,
      sellerPriceRenewal,
    } = req.body;

    const product = await Product.findById(categoryId);

    if (!product) {
      return res.status(404).json({
        message: 'Category not found',
      });
    }

    const subCategory = product.subCategories.id(subCategoryId);

    if (!subCategory) {
      return res.status(404).json({
        message: 'Sub-category not found',
      });
    }

    // Update name
    if (name) {
      const isDuplicate = product.subCategories.some(
        (sc) =>
          sc._id.toString() !== subCategoryId &&
          sc.name.toLowerCase() === name.trim().toLowerCase()
      );

      if (isDuplicate) {
        return res.status(400).json({
          message: 'Sub-category name already in use',
        });
      }

      subCategory.name = name.trim();
    }

    // Determine current/new one-time payment state
    const isOneTimePayment =
      oneTimePayment !== undefined
        ? oneTimePayment === true
        : subCategory.oneTimePayment === true;

    if (isOneTimePayment) {
      subCategory.oneTimePayment = true;
      subCategory.hasPlan = false;
      subCategory.hasRenewal = false;
      subCategory.costPrice = null;
      subCategory.sellerPrice = null;
      subCategory.costPriceRenewal = undefined;
      subCategory.sellerPriceRenewal = undefined;
      subCategory.plans = undefined;
    } else {
      subCategory.oneTimePayment = false;

      if (hasPlan !== undefined) {
        subCategory.hasPlan = !!hasPlan;
      }

      if (hasRenewal !== undefined) {
        subCategory.hasRenewal = hasRenewal !== false;
      }

      if (!subCategory.hasPlan) {
        if (costPrice !== undefined) {
          subCategory.costPrice = Number(costPrice) || 0;
        }

        if (sellerPrice !== undefined) {
          subCategory.sellerPrice = Number(sellerPrice) || 0;
        }

        if (subCategory.hasRenewal) {
          if (costPriceRenewal !== undefined) {
            subCategory.costPriceRenewal = Number(costPriceRenewal) || 0;
          }

          if (sellerPriceRenewal !== undefined) {
            subCategory.sellerPriceRenewal = Number(sellerPriceRenewal) || 0;
          }
        } else {
          subCategory.costPriceRenewal = undefined;
          subCategory.sellerPriceRenewal = undefined;
        }
        subCategory.plans = undefined;
      } else {
        subCategory.costPrice = null;
        subCategory.sellerPrice = null;
        subCategory.costPriceRenewal = undefined;
        subCategory.sellerPriceRenewal = undefined;
        if (!subCategory.plans) {
          subCategory.plans = [];
        }
      }
    }

    await product.save();

    if (req.admin?.email) {
      logActivity(
        req.admin.email,
        'SUBCATEGORY',
        'UPDATE',
        `Updated sub-category: ${subCategory.name}`
      );
    }

    res.json(subCategory);
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

// @desc    Delete sub-category
// @route   DELETE /api/products/:categoryId/subcategories/:subCategoryId
// @access  Private
const deleteSubCategory = async (req, res) => {
  try {
    const { categoryId, subCategoryId } = req.params;

    const product = await Product.findById(categoryId);

    if (!product) {
      return res.status(404).json({
        message: 'Category not found',
      });
    }

    const subCategory = product.subCategories.id(subCategoryId);

    if (!subCategory) {
      return res.status(404).json({
        message: 'Sub-category not found',
      });
    }

    const subCategoryName = subCategory.name;

    subCategory.deleteOne();

    await product.save();

    if (req.admin?.email) {
      logActivity(
        req.admin.email,
        'SUBCATEGORY',
        'DELETE',
        `Deleted sub-category: ${subCategoryName}`
      );
    }

    res.json({
      message: 'Sub-category deleted successfully',
    });
  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};

module.exports = {
  getProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  addSubCategory,
  updateSubCategory,
  deleteSubCategory,
};
