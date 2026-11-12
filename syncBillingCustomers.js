require("dotenv").config();

const mongoose = require("mongoose");
const connectDB = require("./config/db");
const projectDB = require("./ProjectTool/DBconnection");
const Customer = require("./models/Customer");
const syncProjectClient = require("./ProjectTool/services/projectClientSync");

async function main() {
    try {
        await connectDB();
        await projectDB();

        let synced = 0;

        for await (const customer of Customer.find().cursor()) {
            await syncProjectClient(customer);
            synced += 1;
        }

        console.log(`Synced ${synced} billing customer(s) to ProjectDB.`);
    } catch (error) {
        console.error("Customer migration failed:", error);
        process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
        await projectDB.connection.close();
    }
}

main();