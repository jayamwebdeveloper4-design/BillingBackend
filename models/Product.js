const mongoose = require('mongoose');

const planSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Plan name is required'],
      trim: true,
    },
    hasRenewal: {
      type: Boolean,
      default: true,
    },
    costPrice: {
      type: Number,
      default: 0,
      min: [0, 'Cost price must be non-negative'],
    },
    costPriceRenewal: {
      type: Number,
      default: 0,
      min: [0, 'Cost renewal price must be non-negative'],
    },
    sellerPrice: {
      type: Number,
      default: 0,
      min: [0, 'Seller price must be non-negative'],
    },
    sellerPriceRenewal: {
      type: Number,
      default: 0,
      min: [0, 'Seller renewal price must be non-negative'],
    },
  },
  { _id: false }
);

const subCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Sub-category name is required'],
      trim: true,
    },
    oneTimePayment: {
      type: Boolean,
      default: false,
    },
    hasPlan: {
      type: Boolean,
      default: false,
    },
    hasRenewal: {
      type: Boolean,
      default: true,
    },
    costPrice: {
      type: Number,
      default: null,
    },
    costPriceRenewal: {
      type: Number,
      default: null,
    },
    sellerPrice: {
      type: Number,
      default: null,
    },
    sellerPriceRenewal: {
      type: Number,
      default: null,
    },
   
  }
);

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Category name is required'],
      trim: true,
    },
    subCategories: [subCategorySchema],
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

const Product = mongoose.model('Product', productSchema);

module.exports = Product;