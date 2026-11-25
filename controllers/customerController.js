const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const CustomerProduct = require('../models/CustomerProduct');
const ProjectClient = require('../ProjectTool/Models/ProjectClient');
const { cleanArray } = Customer;

const LIST_FIELDS = 'name phone email country state gstin address contactPerson notes createdAt';
const EDITABLE = ['name', 'phone', 'email', 'country', 'state', 'gstin', 'address', 'contactPerson', 'notes'];
const SORT_FIELDS = { createdAt: 'createdAt', name: 'name', state: 'state', country: 'country' };

const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isValidId = id => mongoose.Types.ObjectId.isValid(id);
const pick = (obj, keys) =>
  keys.reduce((acc, k) => (obj[k] !== undefined ? ((acc[k] = obj[k]), acc) : acc), {});

// GET /api/customers?page=1&limit=20&search=ab&state=Tamil Nadu&country=India&from=2026-01-01&to=2026-12-31&sortBy=name&order=asc
exports.getCustomers = async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const dir   = req.query.order === 'asc' ? 1 : -1;
    const sort  = { [SORT_FIELDS[req.query.sortBy] || 'createdAt']: dir, _id: dir }; // _id = stable order

    const filter = {};

    if (req.query.state) filter.state = req.query.state;
    if (req.query.country) filter.country = req.query.country;

    const { from, to } = req.query;
    if (from || to) {
      filter.createdAt = {};
      if (from && !isNaN(new Date(from))) filter.createdAt.$gte = new Date(from);
      if (to && !isNaN(new Date(to))) {
        const toDate = new Date(to);
        if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
          toDate.setHours(23, 59, 59, 999);
        }
        filter.createdAt.$lte = toDate;
      }
      if (!Object.keys(filter.createdAt).length) delete filter.createdAt;
    }

    const search = (req.query.search || '').trim().slice(0, 50);
    if (search) {
      const safe = escapeRegex(search);
      filter.$or = [
        { name: { $regex: safe, $options: 'i' } },
        { email: { $regex: safe, $options: 'i' } },
        { phone: { $regex: safe, $options: 'i' } },
        { contactPerson: { $regex: safe, $options: 'i' } },
        { notes: { $regex: safe, $options: 'i' } },
        { gstin: { $regex: '^' + safe.toUpperCase() } },
      ];
    }

    const hasFilter = Object.keys(filter).length > 0;

    const [data, total] = await Promise.all([
      Customer.find(filter).select(LIST_FIELDS).sort(sort)
        .skip((page - 1) * limit).limit(limit).lean(),
      hasFilter ? Customer.countDocuments(filter) : Customer.estimatedDocumentCount(),
    ]);

    res.json({
      success: true,
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasNext: page * limit < total },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/customers/:id
exports.getCustomerById = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    const customer = await Customer.findById(req.params.id).lean();
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });
    res.json({ success: true, data: customer });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/customers
exports.createCustomer = async (req, res) => {
  try {
    const customer = await Customer.create(pick(req.body, EDITABLE)); // pre('validate') cleans email/phone

    // Sync new customer to ProjectTool database (clinets collection)
    try {
      await ProjectClient.create({
        billingCustomerId: customer._id,
        clientName: customer.name,
        phone: customer.phone || [],
        email: customer.email || [],
        country: customer.country || '',
        state: customer.state || '',
        gstin: customer.gstin || '',
        address: customer.address || '',
        contactPerson: customer.contactPerson || '',
        notes: customer.notes || '',
      });
    } catch (syncErr) {
      console.error('Failed to sync new customer to ProjectTool clinets:', syncErr.message);
    }

    res.status(201).json({ success: true, data: customer });
  } catch (err) {
    const code = err.name === 'ValidationError' ? 400 : 500;
    res.status(code).json({ success: false, message: err.message });
  }
};

// PUT /api/customers/:id  (partial update, single DB call)
exports.updateCustomer = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id' });

    const update = pick(req.body, EDITABLE);
    // pre('validate') does NOT run on findByIdAndUpdate, so clean here
    if (update.email !== undefined) update.email = cleanArray(update.email, true);
    if (update.phone !== undefined) update.phone = cleanArray(update.phone, false);

    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: true }
    ).lean();

    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    // Sync updated customer details to ProjectTool database (clinets collection)
    try {
      const syncUpdate = {};
      if (customer.name) syncUpdate.clientName = customer.name;
      if (customer.phone) syncUpdate.phone = customer.phone;
      if (customer.email) syncUpdate.email = customer.email;
      if (customer.country !== undefined) syncUpdate.country = customer.country;
      if (customer.state !== undefined) syncUpdate.state = customer.state;
      if (customer.gstin !== undefined) syncUpdate.gstin = customer.gstin;
      if (customer.address !== undefined) syncUpdate.address = customer.address;
      if (customer.contactPerson !== undefined) syncUpdate.contactPerson = customer.contactPerson;
      if (customer.notes !== undefined) syncUpdate.notes = customer.notes;

      if (Object.keys(syncUpdate).length > 0) {
        await ProjectClient.updateOne(
          { billingCustomerId: customer._id },
          {
            $set: syncUpdate,
            $setOnInsert: {
              billingCustomerId: customer._id,
              clientName: customer.name,
            },
          },
          { upsert: true }
        );
      }
    } catch (syncErr) {
      console.error('Failed to sync updated customer to ProjectTool clinets:', syncErr.message);
    }

    res.json({ success: true, data: customer });
  } catch (err) {
    const code = err.name === 'ValidationError' ? 400 : 500;
    res.status(code).json({ success: false, message: err.message });
  }
};

// DELETE /api/customers/:id
exports.deleteCustomer = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid id' });

    // 1. Fetch customer details before deleting
    const customer = await Customer.findById(id).lean();
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const snapshot = {
      name: customer.name || '',
      phone: Array.isArray(customer.phone) ? customer.phone : (customer.phone ? [customer.phone] : []),
      email: Array.isArray(customer.email) ? customer.email : (customer.email ? [customer.email] : []),
      gstin: customer.gstin || '',
      address: customer.address || '',
      contactPerson: customer.contactPerson || '',
    };

    // 2. Snapshot into associated Orders and CustomerProducts in parallel
    await Promise.all([
      Order.updateMany(
        { customerId: id },
        { $set: { customerDetails: snapshot, customerId: null } }
      ),
      CustomerProduct.updateMany(
        { customerId: id },
        { $set: { customerDetails: snapshot, customerId: null } }
      ),
    ]);

    // 3. Delete customer record from Customer collection
    await Customer.findByIdAndDelete(id);

    res.json({
      success: true,
      message: 'Customer deleted successfully. Snapshot preserved on related orders and products.',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/customers/:id/record-payment (Backward compatibility for legacy payment recording)
exports.recordCustomerPayment = async (req, res) => {
  try {
    const customerId = req.params.id;
    let orderId = req.body.orderId;
    if (typeof orderId === 'object' && orderId?._id) {
      orderId = String(orderId._id);
    }
    if (!orderId && Array.isArray(req.body.selectedOrderIds) && req.body.selectedOrderIds.length > 0) {
      const first = req.body.selectedOrderIds[0];
      if (typeof first === 'object' && first?._id) orderId = String(first._id);
      else if (typeof first === 'string' && first !== '[object Object]') orderId = first;
    }

    if (!orderId && req.body.productId) {
      const prod = await CustomerProduct.findById(req.body.productId).lean();
      if (prod && prod.orderId) orderId = String(prod.orderId);
    }

    if (!orderId) {
      const latestOrder = await Order.findOne({ customerId }).sort({ createdAt: -1 }).lean();
      if (latestOrder) orderId = String(latestOrder._id);
    }

    if (!orderId) {
      return res.status(404).json({ success: false, message: 'Order not found for this customer payment' });
    }

    const { recordOrderPayment } = require('./Order');
    req.params.id = orderId;
    return recordOrderPayment(req, res);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};