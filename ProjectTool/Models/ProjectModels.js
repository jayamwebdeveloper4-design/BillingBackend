
const mongoose = require("mongoose");

const projectSchema = new mongoose.Schema(
  {
    ProjectName: { type: String, required: true, trim: true },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    serviceName: { type: String, trim: true },
    Budget: {
      currency: { type: String, default: "₹" },
      amount: { type: Number, min: 0 },
    },
    customerName: { type: String, trim: true },
    customerPhone: { type: [String], default: [] },
    customerEmail: { type: [String], default: [] },
  },
  { timestamps: true }
);

projectSchema.index({ createdAt: -1 });
projectSchema.index({ customerId: 1 });

module.exports = mongoose.model("Project", projectSchema);