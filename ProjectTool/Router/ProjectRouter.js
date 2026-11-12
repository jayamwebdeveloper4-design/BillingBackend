const router = require("express").Router();
const { createProject, getProjects } = require("../controller/projectControll");
const SecretKey = require("../Middleware/SecretKey");
const { protect: AdminV } = require("../../middleware/authMiddleware");

router.get("/", SecretKey, getProjects); 
router.post("/", AdminV, createProject); 
module.exports = router;
