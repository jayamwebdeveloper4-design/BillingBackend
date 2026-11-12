const crypto = require("crypto");

module.exports = (req, res, next) => {
  const key = req.header("x-api-key");
    const expected = process.env.TOOL_API_KEY;
  if (!key || !expected) {
    return res.status(401).json({ message: "API key required" });
  }

  // timing-safe compare
  const a = Buffer.from(key);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ message: "Invalid API key" });
  }

  next();
};