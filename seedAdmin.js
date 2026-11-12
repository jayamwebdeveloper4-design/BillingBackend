const bcrypt = require("bcryptjs");
const Admin = require("./models/Admin");

const defaultAuthorizedAdmins = [
  { email: "jayamproj@gmail.com", username: "admin" },
  { email: "jayamweb.promo1@gmail.com", username: "Ashifa Begam M" },
  { email: "jayamwebsolutionspvtltd@gmail.com", username: "jayamwebsolutionspvtltd" },
  { email: "jayamwebbo6@gmail.com", username: "zubair" },
  { email: "jayamweb.designer2@gmail.com", username: "jayamweb.designer2" },
  { email: "manikandan110305@gmail.com", username: "manikandan110305" },
  { email: "jayamweb.developer4@gmail.com", username: "jayamweb.developer4" }
];

const seedAdmin = async () => {
  try {
    const defaultPasswordHash = await bcrypt.hash("admin@123", 10);

    for (const item of defaultAuthorizedAdmins) {
      const emailLower = item.email.toLowerCase().trim();
      const existing = await Admin.findOne({ email: emailLower });

      if (!existing) {
        await Admin.create({
          username: item.username,
          email: emailLower,
          password: defaultPasswordHash,
          role: "admin",
        });
        console.log(`✅ Seeded admin in DB: ${emailLower}`);
      }
    }
    console.log("ℹ️ Authorized admin accounts verified in DB");
  } catch (error) {
    console.error("❌ Error seeding authorized admins:", error.message);
  }
};

module.exports = seedAdmin;