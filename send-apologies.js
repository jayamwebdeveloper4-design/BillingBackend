const dotenv = require("dotenv");
const path = require("path");

// Load env vars
dotenv.config();

const connectDB = require("./config/db");
const Customer = require("./models/Customer");
const sendEmail = require("./utils/sendEmail");
const { apologyTemplate } = require("./utils/emailTemplates");
const { logCron } = require("./utils/logger");

connectDB().then(async () => {
    try {
        logCron("START", "Apology/correction email script execution started.");
        console.log("🔍 Scanning MongoDB for customers with sent expiry/deletion flags...");
        
        // Find customers where at least one order has expiredEmailSend: true OR deletionEmailSend: true
        const customers = await Customer.find({
            $or: [
                { "orders.expiredEmailSend": true },
                { "orders.deletionEmailSend": true }
            ]
        });

        console.log(`Found ${customers.length} customer(s) to process.`);
        let emailsSent = 0;

        for (const customer of customers) {
            // Find which orders actually had the emails sent
            const relevantOrders = customer.orders.filter(o => o.expiredEmailSend === true || o.deletionEmailSend === true);
            
            if (relevantOrders.length === 0) continue;

            const domainList = relevantOrders.map(o => o.domainUrl || "N/A").join(", ");
            const subject = `CORRECTION: Please ignore previous invoice/expiry email for ${domainList}`;
            
            console.log(`📧 Sending apology to ${customer.name} <${customer.email}> for domain(s): ${domainList}`);

            try {
                await sendEmail({
                    email: customer.email,
                    subject,
                    message: apologyTemplate(subject, "")
                });
                emailsSent++;
                logCron("SENT", `Apology/correction email sent to ${customer.name} <${customer.email}> for domain(s): ${domainList}`);

                // Reset flags so future crons/tests can run cleanly
                // customer.orders.forEach(o => {
                //     if (o.expiredEmailSend === true || o.deletionEmailSend === true || o.emailSend === true) {
                //         o.expiredEmailSend = false;
                //         o.deletionEmailSend = false;
                //         o.emailSend = false;
                //     }
                // });
                await customer.save();
                console.log(`✅ Saved reset flags for ${customer.name}`);
            } catch (mailErr) {
                logCron("ERROR", `Failed to send apology email to ${customer.name} <${customer.email}>: ${mailErr.message}`);
                console.error(`❌ Failed to send apology email to ${customer.email}:`, mailErr.message);
            }
        }

        logCron("DONE", `Apology/correction script finished. Sent ${emailsSent} correction email(s).`);
        console.log(`\n🎉 Done! Sent ${emailsSent} correction/apology email(s).`);
    } catch (err) {
        logCron("ERROR", `Apology script fatal error: ${err.message}`);
        console.error("❌ Fatal error in script:", err);
    } finally {
        // Exit process
        setTimeout(() => {
            process.exit(0);
        }, 2000);
    }
});
