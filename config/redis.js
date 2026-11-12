const IORedis = require("ioredis");
const fs = require("fs");

let redisOptions = {
  db: 3,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

const socketPath = process.env.REDIS_PATH;
const isUnixSocketValid = socketPath && process.platform !== "win32" && fs.existsSync(socketPath);

if (isUnixSocketValid) {
  // Production / Staging Linux UNIX Domain Socket
  redisOptions.path = socketPath;
} else if (process.env.REDIS_HOST) {
  // Remote or local TCP host/port if configured
  redisOptions.host = process.env.REDIS_HOST;
  redisOptions.port = Number(process.env.REDIS_PORT) || 6379;
} else {
  // Local environment (Windows / Dev): Attempt localhost TCP with graceful backoff
  redisOptions.host = "127.0.0.1";
  redisOptions.port = 6379;
  redisOptions.retryStrategy = (times) => {
    if (times > 2) {
      // Cease continuous reconnection attempts in local dev if Redis service isn't started
      return null;
    }
    return 1000;
  };
}

const connection = new IORedis(redisOptions);

let hasLoggedOffline = false;

connection.on("connect", () => {
  console.log("✅ Redis Connected");
});

connection.on("error", (err) => {
  if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
    if (!hasLoggedOffline) {
      console.log(`ℹ️ Redis not reachable in local environment (${err.message}). In-memory OTP storage active.`);
      hasLoggedOffline = true;
    }
  } else {
    console.warn("[Redis]", err.message);
  }
});

module.exports = connection;
