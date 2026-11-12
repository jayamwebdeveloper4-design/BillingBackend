const express = require('express');
const router = express.Router();
const {
  requestLoginOtp,
  verifyLoginOtp,
  logoutAdmin,
  getAdminProfile,
  updateProfile,
  getAdminEmail,
} = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

// @desc    Passwordless Login: Request OTP
// @route   POST /api/auth/request-otp
router.post('/request-otp', requestLoginOtp);
router.get('/request-otp', (req, res) => {
  res.json({ status: "ready", message: "Passwordless OTP endpoint is active. Send a POST request with { email }." });
});

// @desc    Passwordless Login: Verify OTP & Issue Token
// @route   POST /api/auth/verify-otp
router.post('/verify-otp', verifyLoginOtp);
router.get('/verify-otp', (req, res) => {
  res.json({ status: "ready", message: "Passwordless OTP verification endpoint is active. Send a POST request with { email, otp }." });
});

// @desc    Logout admin
// @route   POST /api/auth/logout
router.post('/logout', logoutAdmin);

// @desc    Get current admin profile
// @route   GET /api/auth/profile
router.get('/profile', protect, getAdminProfile);

// @desc    Update admin profile
// @route   PUT /api/auth/profile
router.put('/profile', protect, updateProfile);

// @desc    Get admin email (public)
// @route   GET /api/auth/admin-email
router.get('/admin-email', getAdminEmail);

module.exports = router;
