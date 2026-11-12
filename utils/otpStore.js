const crypto = require("crypto");
const redis = require("../config/redis");

// In-memory fallback in case Redis socket is unavailable in local dev environment
const memoryStore = new Map();
const memoryRateLimits = new Map();

// Helper to determine if Redis is operational
const isRedisReady = () => {
  return redis && (redis.status === "ready" || redis.status === "connect");
};

/**
 * Hash an OTP using HMAC-SHA256
 */
const hashOtp = (otp) => {
  const secret = process.env.JWT_SECRET || "billing_default_secure_secret";
  return crypto.createHmac("sha256", secret).update(String(otp)).digest("hex");
};

/**
 * Compare OTP using timing-safe comparison
 */
const verifyOtpHash = (enteredOtp, storedHash) => {
  try {
    const computedHash = hashOtp(enteredOtp);
    const computedBuffer = Buffer.from(computedHash, "hex");
    const storedBuffer = Buffer.from(storedHash, "hex");

    if (computedBuffer.length !== storedBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(computedBuffer, storedBuffer);
  } catch (err) {
    return false;
  }
};

/**
 * Generate a cryptographically secure 6-digit OTP
 */
const generateSecureOtp = () => {
  return crypto.randomInt(100000, 1000000).toString();
};

/**
 * Store OTP in Redis (or in-memory fallback) with TTL in seconds
 */
const storeOtp = async (email, otpHash, ttlSeconds = 300) => {
  const normalizedEmail = email.toLowerCase().trim();
  const key = `otp:${normalizedEmail}`;
  const payload = JSON.stringify({
    otp_hash: otpHash,
    attempts: 0,
    created_at: Date.now(),
  });

  if (isRedisReady()) {
    try {
      await redis.setex(key, ttlSeconds, payload);
      return;
    } catch (err) {
      console.warn("[OTP Store] Redis write failed, falling back to memory:", err.message);
    }
  }

  // Memory fallback
  const timer = setTimeout(() => {
    memoryStore.delete(key);
  }, ttlSeconds * 1000);

  memoryStore.set(key, {
    otp_hash: otpHash,
    attempts: 0,
    created_at: Date.now(),
    timer,
  });
};

/**
 * Retrieve OTP record
 */
const getOtp = async (email) => {
  const normalizedEmail = email.toLowerCase().trim();
  const key = `otp:${normalizedEmail}`;

  if (isRedisReady()) {
    try {
      const data = await redis.get(key);
      if (data) {
        return JSON.parse(data);
      }
      return null;
    } catch (err) {
      console.warn("[OTP Store] Redis read failed, checking memory:", err.message);
    }
  }

  const record = memoryStore.get(key);
  if (!record) return null;
  return {
    otp_hash: record.otp_hash,
    attempts: record.attempts,
    created_at: record.created_at,
  };
};

/**
 * Increment attempt counter for an OTP
 */
const incrementOtpAttempts = async (email) => {
  const normalizedEmail = email.toLowerCase().trim();
  const key = `otp:${normalizedEmail}`;

  if (isRedisReady()) {
    try {
      const data = await redis.get(key);
      if (data) {
        const parsed = JSON.parse(data);
        parsed.attempts = (parsed.attempts || 0) + 1;
        const ttl = await redis.ttl(key);
        if (ttl > 0) {
          await redis.setex(key, ttl, JSON.stringify(parsed));
        }
        return parsed.attempts;
      }
      return 0;
    } catch (err) {
      console.warn("[OTP Store] Redis incr failed, checking memory:", err.message);
    }
  }

  const record = memoryStore.get(key);
  if (record) {
    record.attempts += 1;
    return record.attempts;
  }
  return 0;
};

/**
 * Delete OTP (Replay Prevention / Invalidation)
 */
const deleteOtp = async (email) => {
  const normalizedEmail = email.toLowerCase().trim();
  const key = `otp:${normalizedEmail}`;

  if (isRedisReady()) {
    try {
      await redis.del(key);
    } catch (err) {
      console.warn("[OTP Store] Redis del failed:", err.message);
    }
  }

  const record = memoryStore.get(key);
  if (record && record.timer) {
    clearTimeout(record.timer);
  }
  memoryStore.delete(key);
};

/**
 * Velocity Rate Limit Check (e.g., max 3 requests per 10 minutes)
 * Returns { allowed: boolean, remainingAttempts: number }
 */
const checkRateLimit = async (identifier, maxAttempts = 3, windowSeconds = 600) => {
  const key = `ratelimit:otp:${identifier.toLowerCase().trim()}`;

  if (isRedisReady()) {
    try {
      const current = await redis.incr(key);
      if (current === 1) {
        await redis.expire(key, windowSeconds);
      }
      return {
        allowed: current <= maxAttempts,
        current,
      };
    } catch (err) {
      console.warn("[OTP Store] Redis ratelimit failed, checking memory:", err.message);
    }
  }

  // Memory fallback rate limit
  const now = Date.now();
  const entry = memoryRateLimits.get(key);

  if (!entry || now > entry.resetAt) {
    memoryRateLimits.set(key, {
      count: 1,
      resetAt: now + windowSeconds * 1000,
    });
    return { allowed: true, current: 1 };
  }

  entry.count += 1;
  return {
    allowed: entry.count <= maxAttempts,
    current: entry.count,
  };
};

module.exports = {
  hashOtp,
  verifyOtpHash,
  generateSecureOtp,
  storeOtp,
  getOtp,
  incrementOtpAttempts,
  deleteOtp,
  checkRateLimit,
};
