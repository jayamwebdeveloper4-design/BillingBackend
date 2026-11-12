const { Worker } = require("bullmq");
const dotenv = require("dotenv");
const path = require("path");

// Load environment variables from backend/.env
dotenv.config({ path: path.join(__dirname, "../.env") });

const connection = require("../config/redis");
const connectDB = require("../config/db");
const Customer = require("../models/Customer");
const sendEmail = require("../utils/sendEmail");
const { reminderTemplate } = require("../utils/emailTemplates");
const { logCron } = require("../utils/logger");

// Connect to MongoDB (needed for updating customer details and sending emails via SMTP settings in DB)
connectDB();

const worker = new Worker(
    "emailQueue",
    async (job) => {
        const {
            customerId,
            orderId,
            customerEmail,
            subject,
            content,
            sentType
        } = job.data;

        console.log(`Processing email job: ${job.id} for ${customerEmail} (${sentType})`);

        // await sendEmail({
        //     email: customerEmail,
        //     subject,
        //     message: reminderTemplate(subject, content, sentType)
        // });

        const customer = await Customer.findById(customerId);
        if (!customer) {
            console.log(`Customer not found for ID: ${customerId}`);
            logCron("ERROR", `[${sentType}] Customer not found for ID: ${customerId} (job: ${job.id})`);
            return;
        }

        const order = customer.orders.id(orderId);
        if (!order) {
            console.log(`Order not found for ID: ${orderId} on customer ${customerId}`);
            logCron("ERROR", `[${sentType}] Order not found for ID: ${orderId} on customer ${customerId} (job: ${job.id})`);
            return;
        }

        if (sentType === "Renewal") {
            order.emailSend = true;
        } else if (sentType === "Expired") {
            order.expiredEmailSend = true;
        } else {
            order.deletionEmailSend = true;
        }

        customer.markModified('orders');
        await customer.save();
        console.log("✅ Email Sent and MongoDB Updated for:", customerEmail);
        logCron("SENT", `[${sentType}] Email sent and MongoDB updated for ${customerEmail} (job: ${job.id})`);
    },
    {
        connection,
        concurrency: 5
    }
);

worker.on("completed", (job) => {
    console.log(`✅ Job ${job.id} completed successfully`);
});

worker.on("failed", (job, err) => {
    console.error(`❌ Job ${job ? job.id : "unknown"} failed: ${err.message}`);
    logCron("ERROR", `Job ${job ? job.id : "unknown"} failed: ${err.message}`);
});
