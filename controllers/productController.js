const mongoose = require('mongoose');
const Product = require('../models/Product');
const { logActivity } = require('../utils/logger');

const { isValidObjectId, Types } = mongoose;
const CI = { locale: 'en', strength: 2 }; // case-insensitive collation

/* ---------- helpers ---------- */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const log = (req, type, action, msg) => {
  if (req.admin?.email) logActivity(req.admin.email, type, action, msg);
};

const handleError = (res, err) => {
  if (err instanceof HttpError) return res.status(err.status).json({ message: err.message });
  if (err.code === 11000) return res.status(409).json({ message: 'Product with this name already exists' });
  if (err.name === 'ValidationError' || err.name === 'CastError')
    return res.status(400).json({ message: err.message });
  console.error(err);
  return res.status(500).json({ message: 'Server error' });
};

const assertIds = (...ids) => {
  if (!ids.every(isValidObjectId)) throw new HttpError(400, 'Invalid ID');
};

const cleanName = (name, label = 'Name') => {
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, `${label} is required`);
  return name.trim();
};

const num = (v, fallback = 0) => {
  if (v === undefined) return fallback ?? 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'Prices must be non-negative numbers');
  return n;
};

// One place for all pricing rules. Returns { set, unset }.
const normalizePricing = (input, current = {}) => {
  const oneTime =
    input.oneTimePayment !== undefined ? input.oneTimePayment === true : current.oneTimePayment === true;
  const hasPlan = oneTime ? false : input.hasPlan !== undefined ? !!input.hasPlan : !!current.hasPlan;
  const hasRenewal = oneTime
    ? false
    : (input.hasRenewal !== undefined ? input.hasRenewal : current.hasRenewal) !== false;
  const simple = !oneTime && !hasPlan;

  if (!hasPlan && current.plans?.length) {
    throw new HttpError(409, 'Remove existing plans before switching this sub-category type');
  }

  const set = {
    oneTimePayment: oneTime,
    hasPlan,
    hasRenewal,
    costPrice: simple ? num(input.costPrice, current.costPrice) : null,
    sellerPrice: simple ? num(input.sellerPrice, current.sellerPrice) : null,
  };
  const unset = [];

  if (simple && hasRenewal) {
    set.costPriceRenewal = num(input.costPriceRenewal, current.costPriceRenewal);
    set.sellerPriceRenewal = num(input.sellerPriceRenewal, current.sellerPriceRenewal);
  } else {
    unset.push('costPriceRenewal', 'sellerPriceRenewal');
  }

  if (hasPlan) {
    if (Array.isArray(input.plans)) {
      set.plans = input.plans.map((p) => ({
        name: cleanName(p.name, 'Plan name'),
        hasRenewal: p.hasRenewal !== false,
        costPrice: num(p.costPrice),
        costPriceRenewal: p.hasRenewal !== false ? num(p.costPriceRenewal) : 0,
        sellerPrice: num(p.sellerPrice),
        sellerPriceRenewal: p.hasRenewal !== false ? num(p.sellerPriceRenewal) : 0,
      }));
    } else if (!current.plans) {
      set.plans = [];
    }
  } else {
    unset.push('plans');
  }

  return { set, unset };
};

/* ---------- products ---------- */

// GET /api/products?page=1&limit=20   (no params = all, same array response as before)
const getProducts = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 0, 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

    let query = Product.find({}).sort({ createdAt: -1 }).lean();
    if (limit) {
      query = query.skip((page - 1) * limit).limit(limit);
      const [products, total] = await Promise.all([query, Product.estimatedDocumentCount()]);
      res.set('X-Total-Count', total);
      return res.json(products);
    }
    res.json(await query);
  } catch (err) {
    handleError(res, err);
  }
};

// POST /api/products
const createProduct = async (req, res) => {
  try {
    const name = cleanName(req.body.name);
    const rawSubs = Array.isArray(req.body.subCategories) ? req.body.subCategories : [];

    const seen = new Set();
    const subCategories = rawSubs.map((sc) => {
      const scName = cleanName(sc.name, 'Sub-category name');
      const key = scName.toLowerCase();
      if (seen.has(key)) throw new HttpError(400, `Duplicate sub-category: ${scName}`);
      seen.add(key);
      const { set } = normalizePricing(sc);
      return { name: scName, ...set };
    });

    // unique index rejects duplicate names atomically
    const created = await Product.create({ name, subCategories });

    log(req, 'PRODUCT', 'SUCCESS', `Created product: ${created.name}`);
    res.status(201).json(created);
  } catch (err) {
    handleError(res, err);
  }
};

// PUT /api/products/:id  (name only; sub-categories use their own endpoints)
const updateProduct = async (req, res) => {
  try {
    assertIds(req.params.id);
    const name = cleanName(req.body.name);

    const updated = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: { name } },
      { new: true, runValidators: true, collation: CI, lean: true }
    );
    if (!updated) throw new HttpError(404, 'Product not found');

    log(req, 'PRODUCT', 'UPDATE', `Updated product: ${updated.name}`);
    res.json(updated);
  } catch (err) {
    handleError(res, err);
  }
};

// DELETE /api/products/:id  (single query)
const deleteProduct = async (req, res) => {
  try {
    assertIds(req.params.id);
    const deleted = await Product.findByIdAndDelete(req.params.id, { projection: { name: 1 }, lean: true });
    if (!deleted) throw new HttpError(404, 'Product not found');

    log(req, 'PRODUCT', 'DELETE', `Deleted product: ${deleted.name}`);
    res.json({ message: 'Product removed' });
  } catch (err) {
    handleError(res, err);
  }
};

/* ---------- sub-categories (all atomic, no load-modify-save) ---------- */

// POST /api/products/:categoryId/subcategories
const addSubCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;
    assertIds(categoryId);

    const name = cleanName(req.body.name, 'Sub-category name');
    const { set } = normalizePricing(req.body);
    const newSub = { _id: new Types.ObjectId(), name, ...set };
    if (set.hasPlan) newSub.plans = [];

    // Pushes only if no sub-category with the same name exists (case-insensitive)
    const product = await Product.findOneAndUpdate(
      { _id: categoryId, subCategories: { $not: { $elemMatch: { name } } } },
      { $push: { subCategories: newSub } },
      { collation: CI, new: true, projection: { name: 1 }, lean: true }
    );

    if (!product) {
      const exists = await Product.exists({ _id: categoryId });
      throw exists
        ? new HttpError(409, 'Sub-category with this name already exists')
        : new HttpError(404, 'Category not found');
    }

    log(req, 'SUBCATEGORY', 'SUCCESS', `Added sub-category: ${name} to ${product.name}`);
    res.status(201).json(newSub);
  } catch (err) {
    handleError(res, err);
  }
};

// PUT /api/products/:categoryId/subcategories/:subCategoryId
const updateSubCategory = async (req, res) => {
  try {
    const { categoryId, subCategoryId } = req.params;
    assertIds(categoryId, subCategoryId);
    const subId = new Types.ObjectId(subCategoryId);

    // fetch only the one sub-category we need
    const existing = await Product.findOne(
      { _id: categoryId, 'subCategories._id': subId },
      { subCategories: { $elemMatch: { _id: subId } } }
    ).lean();
    if (!existing) throw new HttpError(404, 'Sub-category not found');

    const { set, unset } = normalizePricing(req.body, existing.subCategories[0]);

    const name = req.body.name !== undefined ? cleanName(req.body.name, 'Sub-category name') : null;
    if (name) set.name = name;

    const prefix = 'subCategories.$[sc].';
    const update = {
      $set: Object.fromEntries(Object.entries(set).map(([k, v]) => [prefix + k, v])),
    };
    if (unset.length) update.$unset = Object.fromEntries(unset.map((k) => [prefix + k, '']));

    const filter = { _id: categoryId, 'subCategories._id': subId };
    if (name) {
      // block if ANOTHER sub-category already uses this name
      filter.$nor = [{ subCategories: { $elemMatch: { _id: { $ne: subId }, name } } }];
    }

    const updated = await Product.findOneAndUpdate(filter, update, {
      arrayFilters: [{ 'sc._id': subId }],
      collation: CI,
      new: true,
      projection: { subCategories: { $elemMatch: { _id: subId } } },
      lean: true,
    });

    if (!updated) throw new HttpError(409, 'Sub-category name already in use');

    const sub = updated.subCategories[0];
    log(req, 'SUBCATEGORY', 'UPDATE', `Updated sub-category: ${sub.name}`);
    res.json(sub);
  } catch (err) {
    handleError(res, err);
  }
};

// DELETE /api/products/:categoryId/subcategories/:subCategoryId  (single query)
const deleteSubCategory = async (req, res) => {
  try {
    const { categoryId, subCategoryId } = req.params;
    assertIds(categoryId, subCategoryId);
    const subId = new Types.ObjectId(subCategoryId);

    // returns the document BEFORE the pull, so we can log the name
    const before = await Product.findOneAndUpdate(
      { _id: categoryId, 'subCategories._id': subId },
      { $pull: { subCategories: { _id: subId } } },
      { new: false, projection: { subCategories: { $elemMatch: { _id: subId } } }, lean: true }
    );
    if (!before) throw new HttpError(404, 'Sub-category not found');

    log(req, 'SUBCATEGORY', 'DELETE', `Deleted sub-category: ${before.subCategories[0].name}`);
    res.json({ message: 'Sub-category deleted successfully' });
  } catch (err) {
    handleError(res, err);
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