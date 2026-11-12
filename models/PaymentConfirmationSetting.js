const mongoose = require('mongoose');

// Singleton settings document for payment confirmation settings
const paymentConfirmationSettingSchema = new mongoose.Schema({
  sendPaymentConfirmationEmail: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

module.exports = mongoose.model('PaymentConfirmationSetting', paymentConfirmationSettingSchema);
