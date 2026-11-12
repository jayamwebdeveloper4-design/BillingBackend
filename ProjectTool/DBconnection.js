const mongoose = require('mongoose');

const projectConnection = mongoose.createConnection();

const connectProjectDB = async () => {
  try {
    if (!process.env.projectDB_URL) {
      throw new Error('projectDB_URL is not configured');
    }

    const conn = await projectConnection.openUri(process.env.projectDB_URL);
    console.log(`✅ project MongoDB Connected: ${conn.host}`);
    return conn;
  } catch (error) {
    console.error(`❌ project MongoDB Connection Error: ${error.message}`);
    process.exit(1);
  }
};

connectProjectDB.connection = projectConnection;

module.exports = connectProjectDB;
