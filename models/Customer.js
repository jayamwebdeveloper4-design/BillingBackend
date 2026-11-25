const mongoose = require('mongoose');

const cleanArray = (val, isEmail = false) => {
  if (!val) return [];
  let rawList = [];
  if (typeof val === 'string') rawList = val.split(',');
  else if (Array.isArray(val)) rawList = val.flatMap(i => (typeof i === 'string' ? i.split(',') : [i]));
  else rawList = [String(val)];
  return Array.from(new Set(
    rawList.map(i => String(i).trim()).map(i => (isEmail ? i.toLowerCase() : i)).filter(Boolean)
  ));
};

const nonEmpty = {
  validator: v => Array.isArray(v) && v.length > 0,
};

const customerSchema = new mongoose.Schema({
  name:    { type: String, required: true, trim: true },
  phone:   { type: [String], required: true, validate: { ...nonEmpty, message: 'At least one phone number is required.' } },
  email:   { type: [String], required: true, validate: { ...nonEmpty, message: 'At least one email is required.' } },
  country: { type: String, trim: true, default: '' },
  state:   { type: String, enum: ['Tamil Nadu', 'Other State'], default: 'Tamil Nadu' },
  gstin:   { type: String, trim: true, default: '' },
  address: { type: String, required: true, trim: true },
  contactPerson: { type: String, trim: true },
  notes:   { type: String, trim: true },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

customerSchema.pre('validate', function (next) {
  this.email = cleanArray(this.email, true);
  this.phone = cleanArray(this.phone, false);
  next();
});

customerSchema.virtual('orders', {
  ref: 'Order',
  localField: '_id',
  foreignField: 'customerId',
});

// Indexes (each one matches a filter/sort used in the controller)
customerSchema.index({ createdAt: -1, _id: -1 });
customerSchema.index({ name: 1, _id: 1 });
customerSchema.index({ state: 1, createdAt: -1 });
customerSchema.index({ email: 1 });
customerSchema.index({ phone: 1 });
customerSchema.index({ gstin: 1 });

const Customer = mongoose.models.Customer || mongoose.model('Customer', customerSchema);
module.exports = Customer;
module.exports.cleanArray = cleanArray;