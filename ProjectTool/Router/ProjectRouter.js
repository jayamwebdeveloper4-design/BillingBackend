const router = require("express").Router();
const { createProject, getProjects } = require("../controller/projectControll");
const SecretKey = require("../Middleware/SecretKey");
const { protect: AdminV } = require("../../middleware/authMiddleware");
const { getActiveEmployees ,getActiveEmployeeAttendance} = require("../controller/employeecontroller");


router.get("/", SecretKey, getProjects); 
router.post("/", AdminV, createProject); 
module.exports = router;


router.get("/employees", SecretKey, getActiveEmployees);
router.get("/attendance",SecretKey, getActiveEmployeeAttendance)