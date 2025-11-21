// const express = require("express");
// const router = express.Router();
// const projectController = require("../controllers/projectController");
// const authMiddleware = require("../middleware/auth.js"); // make sure path is correct

// // ✅ All routes now require authentication
// // Roles: manager and admin (employees can also see projects if you allow)
// router.post("/", authMiddleware(["manager", "admin"]), projectController.createProject);
// router.get("/", authMiddleware(["manager", "admin", "employee"]), projectController.getProjects);
// router.get("/:id", authMiddleware(["manager", "admin", "employee"]), projectController.getProjectById);
// router.put("/:id", authMiddleware(["manager", "admin"]), projectController.updateProject);
// router.delete("/:id", authMiddleware(["manager", "admin"]), projectController.deleteProject);

// module.exports = router;


const express = require("express");
const router = express.Router();
const projectController = require("../controllers/projectController");
const authMiddleware = require("../middleware/auth.js");

// ✅ Enhanced CRUD routes with automation
router.post("/", authMiddleware(["manager", "admin"]), projectController.createProject);
router.get("/", authMiddleware(["manager", "admin", "employee"]), projectController.getProjects);
router.get("/names", authMiddleware(["manager", "admin", "employee"]), projectController.getProjectNames);
router.get("/:id", authMiddleware(["manager", "admin", "employee"]), projectController.getProjectById);
router.put("/:id", authMiddleware(["manager", "admin"]), projectController.updateProject);
router.delete("/:id", authMiddleware(["manager", "admin"]), projectController.deleteProject);

// ✅ New enhanced routes
router.get("/analytics/overview", authMiddleware(["manager", "admin"]), projectController.getProjectAnalytics);

module.exports = router;