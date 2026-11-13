const mongoose = require("mongoose");
const Project = require("../Models/ProjectModels");
const Customer = require("../../models/Customer"); // adjust path

// POST /api/projects -> one project at a time
exports.createProject = async (req, res) => {
  try {
    const {
      ProjectName: projectName,
      customerId,
      serviceName,
      Budget: budget,
    } = req.body;

    if (!projectName || !customerId) {
      return res.status(400).json({ message: "ProjectName and customerId required" });
    }
    if (!mongoose.isValidObjectId(customerId)) {
      return res.status(400).json({ message: "Invalid customerId" });
    }

    const customer = await Customer.findById(customerId)
      .select("name phone email")
      .lean();

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    const project = await Project.create({
      projectName,
      billingCustomerId: customer._id,
      serviceName,
      budget, // { currency, amount }; currency defaults to ₹
      customerName: customer.name,
      customerPhone: [].concat(customer.phone || []),
      customerEmail: [].concat(customer.email || []),
    });

    res.status(201).json(project);
  } catch (err) {
    if (err.name === "ValidationError") {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: "Failed to create project" });
  }
};

// GET /api/projects -> all, latest first, paginated
exports.getProjects = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);

    const [projects, total] = await Promise.all([
      Project.find()
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Project.estimatedDocumentCount(),
    ]);

    res.json({ total, page, limit, data: projects });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch projects" });
  }
};