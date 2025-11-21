const express = require("express");
const router = express.Router();
const moduleController = require("../controllers/moduleController");
const authMiddleware = require("../middleware/auth.js");

// Only managers and admins can create, update, delete modules
router.post("/", authMiddleware(["manager", "admin"]), moduleController.createModule);
router.put("/:id", authMiddleware(["manager", "admin"]), moduleController.updateModule);
router.delete("/:id", authMiddleware(["manager", "admin"]), moduleController.deleteModule);

// Any logged-in user can view modules
router.get("/", authMiddleware(["manager", "admin", "employee"]), moduleController.getModules);
router.get("/:id", authMiddleware(["manager", "admin", "employee"]), moduleController.getModuleById);

module.exports = router;
