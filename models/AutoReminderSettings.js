const mongoose = require('mongoose');

// Singleton settings document — only one record is ever stored
const autoReminderSettingsSchema = new mongoose.Schema({
  enabled: {
    type: Boolean,
    default: true
  },
  daysBefore: {
    type: Number,
    default: 7
  },
  sendExpiredEmail: {
    type: Boolean,
    default: true
  },
  sendDeletionEmail: {
    type: Boolean,
    default: true
  },
  deletionDaysAfter: {
    type: Number,
    default: 7
  }
}, { timestamps: true });

module.exports = mongoose.model('AutoReminderSettings', autoReminderSettingsSchema);
