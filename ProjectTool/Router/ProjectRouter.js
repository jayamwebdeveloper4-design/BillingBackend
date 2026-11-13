const router = require("express").Router();
const { createProject, getProjects } = require("../controller/projectControll");
const SecretKey = require("../Middleware/SecretKey");
const { protect: AdminV } = require("../../middleware/authMiddleware");
const { getActiveEmployees ,getActiveEmployeeAttendance} = require("../controller/employeecontroller");
const { getProjectTimesheet } = require("../controller/projectTimesheet");


router.get("/", SecretKey, getProjects); 
router.post("/", AdminV, createProject); 
router.get("/employees", SecretKey, getActiveEmployees);
router.get("/attendance",SecretKey, getActiveEmployeeAttendance)
router.get("/timesheets", AdminV, getProjectTimesheet);

module.exports = router;