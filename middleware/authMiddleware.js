const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');
const { logActivity } = require('../utils/logger');

const protect = async (req, res, next) => {
  let token;

  // Check for token in Authorization header or in cookies
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.cookies && req.cookies.billing_token) {
    token = req.cookies.billing_token;
  }

  if (!token) {
    logActivity('unknown', 'AUTH', 'NO_TOKEN', 'Not authorized: No token provided');
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Fetch admin details (excluding password)
    const admin = await Admin.findById(decoded.id).select('-password');
    
    if (!admin) {
      logActivity('unknown', 'AUTH', 'FAILED', 'Not authorized: Admin account not found');
      return res.status(401).json({ message: 'Not authorized, admin not found' });
    }

    // Compare tokenVersion in JWT payload with the active version in database
    const currentVersion = admin.tokenVersion || 0;
    
    const tokenVersion = decoded.tokenVersion || 0;

    if (tokenVersion !== currentVersion) {
      logActivity(admin.email, 'AUTH', 'EXPIRED', 'Session expired: Token version mismatch (password updated or reset)');
      return res.status(401).json({ message: 'Session expired, please login again' });
    }

    req.admin = admin;
    return next();
  } catch (error) {
    let userEmail = 'unknown';
    try {
      if (token) {
        const decoded = jwt.decode(token);
        if (decoded && decoded.id) {
          const admin = await Admin.findById(decoded.id).select('email');
          if (admin) userEmail = admin.email;
        }
      }
    } catch (e) {
      // Ignore error during decoding
    }

    if (error.name === 'TokenExpiredError') {
      logActivity(userEmail, 'AUTH', 'EXPIRED', 'Session expired: JWT token expired');
    } else {
      logActivity(userEmail, 'AUTH', 'FAILED', `Authentication failed: ${error.message}`);
    }

    console.error('Authentication Error:', error.message);
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }
};

module.exports = { protect };
