const mongoose = require('mongoose');

const invoiceSequenceSchema = new mongoose.Schema({
  monthYear: {
    type: String, // e.g., "07-2026"
    required: true
  },
  invoiceType: {
    type: String, // "withGST" or "withoutGST"
    required: true,
    enum: ['withGST', 'withoutGST']
  },
  sequence: {
    type: Number,
    default: 0
  }
});

// Compound unique index: one counter per month per invoice type
invoiceSequenceSchema.index({ monthYear: 1, invoiceType: 1 }, { unique: true });

module.exports = mongoose.model('InvoiceSequence', invoiceSequenceSchema);
