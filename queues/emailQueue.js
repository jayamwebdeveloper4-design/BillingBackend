const { Queue } = require("bullmq");
const connection = require("../config/redis");

const emailQueue = new Queue("emailQueue", {
    connection,
});

module.exports = emailQueue;
