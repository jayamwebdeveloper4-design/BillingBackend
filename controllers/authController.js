const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const sendEmail = require("../utils/sendEmail");
const { logActivity } = require("../utils/logger");
const { loginOtpTemplate } = require("../utils/emailTemplates");
const {
  hashOtp,
  verifyOtpHash,
  generateSecureOtp,
  storeOtp,
  getOtp,
  incrementOtpAttempts,
  deleteOtp,
  checkRateLimit,
} = require("../utils/otpStore");

// Helper to generate JWT session token
const generateToken = (id, tokenVersion) => {
  const sessionDays = Number(process.env.SESSION_EXPIRY_DAYS) || 30;
  return jwt.sign({ id, tokenVersion }, process.env.JWT_SECRET, {
    expiresIn: `${sessionDays}d`,
  });
};

// @desc    Request Passwordless Login OTP
// @route   POST /api/auth/request-otp
const requestLoginOtp = async (req, res) => {
  const emailRaw = req.body.email ? req.body.email.trim() : "";
  const email = emailRaw.toLowerCase();
  const clientIp = req.ip || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown_ip";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: "A valid email address is required" });
  }

  try {
    // Configurable rate limit parameters
    const emailLimitCount = Number(process.env.OTP_RATE_LIMIT_EMAIL_COUNT) || 3;
    const emailLimitWindow = Number(process.env.OTP_RATE_LIMIT_EMAIL_WINDOW_SECONDS) || 600;
    const ipLimitCount = Number(process.env.OTP_RATE_LIMIT_IP_COUNT) || 10;
    const ipLimitWindow = Number(process.env.OTP_RATE_LIMIT_IP_WINDOW_SECONDS) || 600;
    const otpTtl = Number(process.env.OTP_EXPIRY_SECONDS) || 300;

    // 1. Velocity rate-limit check
    const emailLimit = await checkRateLimit(email, emailLimitCount, emailLimitWindow);
    const ipLimit = await checkRateLimit(clientIp, ipLimitCount, ipLimitWindow);

    if (!emailLimit.allowed || !ipLimit.allowed) {
      logActivity(email, "AUTH", "RATE_LIMIT", "Too many OTP requests");
      const waitMinutes = Math.ceil(emailLimitWindow / 60);
      return res.status(429).json({
        message: `Too many OTP requests. Please wait ${waitMinutes} minutes before requesting again.`,
      });
    }

    // 2. Query MongoDB Admin collection
    const admin = await Admin.findOne({ email });

    // If email is not registered in the database, return generic success without emailing
    if (!admin) {
      logActivity(email, "AUTH", "UNAUTHORIZED", "OTP requested for unregistered admin email");
      return res.status(200).json({
        status: "success",
        message: "If registered, an OTP has been sent to your email address.",
      });
    }

    // 3. Cryptographically secure random 6-digit OTP
    const rawOtp = generateSecureOtp();
    console.log("otp : ", rawOtp);

    // 4. Compute HMAC-SHA256 hash
    const otpHash = hashOtp(rawOtp);

    // 5. Cache with configurable TTL in seconds
    await storeOtp(email, otpHash, otpTtl);

    // 6. Dispatch raw OTP via SMTP
    try {
      const validityMinutes = Math.ceil(otpTtl / 60);
      await sendEmail({
        email: admin.email,
        subject: "Your Billing Manager Login Code",
        message: loginOtpTemplate(rawOtp, validityMinutes),
      });
      logActivity(email, "AUTH", "OTP_SENT", "Login OTP dispatched to email");
    } catch (mailErr) {
      console.error("[OTP Email Error]:", mailErr.message);
      await deleteOtp(email);
      return res.status(500).json({ message: "Email delivery failed: " + mailErr.message });
    }

    return res.status(200).json({
      status: "success",
      message: "If registered, an OTP has been sent to your email address.",
    });
  } catch (error) {
    console.error("requestLoginOtp error:", error);
    logActivity(email || "unknown", "ERROR", "SYSTEM", error.message);
    return res.status(500).json({ message: "Failed to generate OTP: " + error.message });
  }
};

// @desc    Verify OTP & Issue Session
// @route   POST /api/auth/verify-otp
const verifyLoginOtp = async (req, res) => {
  const emailRaw = req.body.email ? req.body.email.trim() : "";
  const email = emailRaw.toLowerCase();
  const enteredOtp = req.body.otp ? String(req.body.otp).trim() : "";

  if (!email || !enteredOtp) {
    return res.status(400).json({ message: "Email and 6-digit OTP code are required" });
  }

  try {
    const maxAttempts = Number(process.env.OTP_MAX_ATTEMPTS);
    const sessionDays = Number(process.env.SESSION_EXPIRY_DAYS) ;

    // 1. Fetch record from Redis / store
    const record = await getOtp(email);
    if (!record) {
      logActivity(email, "AUTH", "FAILED", "OTP verification failed: expired or not found");
      return res.status(400).json({ message: "OTP expired or invalid. Please request a new code." });
    }

    // 2. Increment attempt counter & brute force lockout check
    const attempts = await incrementOtpAttempts(email);
    if (attempts > maxAttempts) {
      await deleteOtp(email);
      logActivity(email, "AUTH", "LOCKOUT", "Brute-force lockout triggered on OTP");
      return res.status(429).json({
        message: "Too many failed attempts. This OTP has been invalidated for security. Please request a new code.",
      });
    }

    // 3. Constant-time HMAC comparison (timing attack safe)
    const isMatch = verifyOtpHash(enteredOtp, record.otp_hash);
    if (!isMatch) {
      const remainingAttempts = Math.max(0, maxAttempts - attempts);
      logActivity(email, "AUTH", "FAILED", `Invalid OTP code (${attempts}/${maxAttempts})`);
      return res.status(401).json({
        message: `Invalid OTP code. ${remainingAttempts} attempt(s) remaining.`,
      });
    }

    // 4. Replay Prevention: delete OTP immediately upon verification
    await deleteOtp(email);

    // 5. Query user in database
    const admin = await Admin.findOne({ email });
    if (!admin) {
      logActivity(email, "AUTH", "FAILED", "Admin record not found after OTP verification");
      return res.status(401).json({ message: "Account not authorized" });
    }

    // 6. Sign JWT session token
    const token = generateToken(admin._id, admin.tokenVersion || 0);

    // 7. Set secure HttpOnly cookie & return response
    const isProd = process.env.NODE_ENV === "production";
    const isSecure = process.env.COOKIE_SECURE !== undefined
      ? process.env.COOKIE_SECURE === "true"
      : isProd;
    const isHttpOnly = process.env.COOKIE_HTTP_ONLY !== "false";
    const sameSite = process.env.COOKIE_SAMESITE || "strict";

    res.cookie("billing_token", token, {
      httpOnly: isHttpOnly,
      secure: isSecure,
      sameSite: sameSite,
      maxAge: sessionDays * 24 * 60 * 60 * 1000,
      path: "/",
    });

    logActivity(email, "AUTH", "SUCCESS", "Admin logged in successfully via OTP");

    return res.status(200).json({
      _id: admin._id,
      username: admin.username,
      email: admin.email,
      role: admin.role,
      token,
    });
  } catch (error) {
    console.error("verifyLoginOtp error:", error);
    logActivity(email || "unknown", "ERROR", "SYSTEM", error.message);
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Logout admin
// @route   POST /api/auth/logout
const logoutAdmin = async (req, res) => {
  let userEmail = "unknown";
  try {
    let token;
    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer")
    ) {
      token = req.headers.authorization.split(" ")[1];
    } else if (req.cookies && req.cookies.billing_token) {
      token = req.cookies.billing_token;
    }

    if (token) {
      const decoded = jwt.decode(token);
      if (decoded && decoded.id) {
        const admin = await Admin.findById(decoded.id).select("email");
        if (admin) userEmail = admin.email;
      }
    }
  } catch (err) {
    // Ignore error
  }

  logActivity(userEmail, "AUTH", "LOGOUT", "Admin logged out successfully");

  const isProd = process.env.NODE_ENV === "production";
  const isSecure = process.env.COOKIE_SECURE !== undefined
    ? process.env.COOKIE_SECURE === "true"
    : isProd;
  const isHttpOnly = process.env.COOKIE_HTTP_ONLY !== "false";
  const sameSite = process.env.COOKIE_SAMESITE || "strict";

  res.cookie("billing_token", "", {
    httpOnly: isHttpOnly,
    secure: isSecure,
    sameSite: sameSite,
    expires: new Date(0),
    path: "/",
  });
  res.status(200).json({ message: "Logged out" });
};

// @desc    Get current admin profile
// @route   GET /api/auth/profile
const getAdminProfile = async (req, res) => {
  try {
    res.json(req.admin);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update admin profile
// @route   PUT /api/auth/profile
const updateProfile = async (req, res) => {
  const username = req.body.username ? req.body.username.trim() : "";
  const email = req.body.email ? req.body.email.trim() : "";

  try {
    const admin = await Admin.findById(req.admin._id);

    if (admin) {
      admin.username = username || admin.username;
      admin.email = email || admin.email;

      const updatedAdmin = await admin.save();

      logActivity(admin.email, "PROFILE", "UPDATE", "Profile details updated");

      res.json({
        _id: updatedAdmin._id,
        username: updatedAdmin.username,
        email: updatedAdmin.email,
      });
    } else {
      res.status(404).json({ message: "Admin not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get admin email (public)
// @route   GET /api/auth/admin-email
const getAdminEmail = async (req, res) => {
  try {
    const admin = await Admin.findOne().select("email");
    if (admin) {
      res.json({ email: admin.email });
    } else {
      res.status(404).json({ message: "Admin not found" });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  requestLoginOtp,
  verifyLoginOtp,
  logoutAdmin,
  getAdminProfile,
  updateProfile,
  getAdminEmail,
};
