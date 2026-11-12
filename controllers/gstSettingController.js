const GstSetting = require('../models/GstSetting');

// @desc    Get global GST settings
// @route   GET /api/gst-settings
// @access  Private
const getGstSettings = async (req, res) => {
  try {
    let settings = await GstSetting.findOne();
    if (!settings) {
      settings = await GstSetting.create({
        companyName: "",
        companyNameWithoutGst: "",
        address: "",
        addressWithoutGst: "",
        phone: "",
        phoneWithoutGst: "",
        email: "",
        emailWithoutGst: "",
        gstin: "",
        cgstPercentage: 9,
        sgstPercentage: 9,
        igstPercentage: 18,
        signatureImage: '',
        bankAccountName: 'JAYAM TECHNOLOGIES',
        bankAccountNumber: '120035000004',
        bankName: 'Canara Bank',
        bankBranch: 'Perungalathur',
        bankIfsc: 'CNRB0003856',
        gpayNumber: '9840599789',
        bankAccountNameWithoutGst: 'Jayam Web Solutions',
        bankAccountNumberWithoutGst: '722473240',
        bankNameWithoutGst: 'Indian Bank',
        bankBranchWithoutGst: 'Tambaram West, Chennai',
        bankIfscWithoutGst: 'IDIB000T092',
        gpayNumberWithoutGst: '9677876445'
      });
    }
    res.json(settings);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
};

// @desc    Update global GST settings
// @route   PUT /api/gst-settings
// @access  Private
const updateGstSettings = async (req, res) => {
  try {
    const { 
      companyName, companyNameWithoutGst, address, addressWithoutGst, phone, phoneWithoutGst, email, emailWithoutGst, gstin, 
      cgstPercentage, sgstPercentage, igstPercentage, signatureImage,
      bankAccountName, bankAccountNumber, bankName, bankBranch, bankIfsc, gpayNumber,
      bankAccountNameWithoutGst, bankAccountNumberWithoutGst, bankNameWithoutGst, bankBranchWithoutGst, bankIfscWithoutGst, gpayNumberWithoutGst
    } = req.body;

    let settings = await GstSetting.findOne();
    
    if (!settings) {
      settings = new GstSetting();
    }
    
    if (companyName !== undefined) settings.companyName = companyName;
    if (companyNameWithoutGst !== undefined) settings.companyNameWithoutGst = companyNameWithoutGst;
    if (address !== undefined) settings.address = address;
    if (addressWithoutGst !== undefined) settings.addressWithoutGst = addressWithoutGst;
    if (phone !== undefined) settings.phone = phone;
    if (phoneWithoutGst !== undefined) settings.phoneWithoutGst = phoneWithoutGst;
    if (email !== undefined) settings.email = email;
    if (emailWithoutGst !== undefined) settings.emailWithoutGst = emailWithoutGst;
    if (gstin !== undefined) settings.gstin = gstin;
    if (cgstPercentage !== undefined) settings.cgstPercentage = cgstPercentage;
    if (sgstPercentage !== undefined) settings.sgstPercentage = sgstPercentage;
    if (igstPercentage !== undefined) settings.igstPercentage = igstPercentage;
    if (signatureImage !== undefined) settings.signatureImage = signatureImage;

    // Bank Details With GST
    if (bankAccountName !== undefined) settings.bankAccountName = bankAccountName;
    if (bankAccountNumber !== undefined) settings.bankAccountNumber = bankAccountNumber;
    if (bankName !== undefined) settings.bankName = bankName;
    if (bankBranch !== undefined) settings.bankBranch = bankBranch;
    if (bankIfsc !== undefined) settings.bankIfsc = bankIfsc;
    if (gpayNumber !== undefined) settings.gpayNumber = gpayNumber;

    // Bank Details Without GST
    if (bankAccountNameWithoutGst !== undefined) settings.bankAccountNameWithoutGst = bankAccountNameWithoutGst;
    if (bankAccountNumberWithoutGst !== undefined) settings.bankAccountNumberWithoutGst = bankAccountNumberWithoutGst;
    if (bankNameWithoutGst !== undefined) settings.bankNameWithoutGst = bankNameWithoutGst;
    if (bankBranchWithoutGst !== undefined) settings.bankBranchWithoutGst = bankBranchWithoutGst;
    if (bankIfscWithoutGst !== undefined) settings.bankIfscWithoutGst = bankIfscWithoutGst;
    if (gpayNumberWithoutGst !== undefined) settings.gpayNumberWithoutGst = gpayNumberWithoutGst;
    
    const updatedSettings = await settings.save();
    res.json(updatedSettings);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
};

// @desc    Upload signature image
// @route   POST /api/gst-settings/upload
// @access  Private
const uploadSignature = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Please upload a signature file.' });
    }
    const relativePath = `uploads/${req.file.filename}`;
    res.json({ filePath: relativePath });
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
};

module.exports = {
  getGstSettings,
  updateGstSettings,
  uploadSignature
};
