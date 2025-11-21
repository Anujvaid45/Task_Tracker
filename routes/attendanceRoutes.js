const express = require("express");
const mongoose = require("mongoose");
const Attendance = require("../models/Attendance.js");
const Employee = require("../models/Employee.js");
const authMiddleware = require("../middleware/auth.js");

const router = express.Router();

/**
 * Helper: resolve managerId for current user
 */
function getManagerId(user) {
  if (user.role === "manager") return user.id;
  if (user.role === "admin") return user.managerId;
  return null;
}

/**
 * Helper: ensure employee belongs to same manager as current user
 */
async function ensureSameManager(user, employeeId) {
  const emp = await Employee.findOne({ employeeId });
  if (!emp || emp.role === "manager") return null;

  const currentManagerId = getManagerId(user);
  if (!currentManagerId) return null;

  if (!emp.managerId || emp.managerId.toString() !== currentManagerId.toString()) {
    return null;
  }

  return emp;
}

/**
 * Mark attendance - supports both employee self-marking and admin/manager marking for others
 */
router.post(
  "/mark",
  authMiddleware(["admin", "manager", "employee"]),
  async (req, res) => {
    try {
      const targetEmployeeId = req.body.employeeId || req.user.employeeId;
      const { day, present, checkIn, checkOut, hoursWorked, notes } = req.body;

      // Only admin/manager can mark attendance for others
      if (req.body.employeeId && !["admin", "manager"].includes(req.user.role)) {
        return res
          .status(403)
          .json({ error: "Not authorized to mark attendance for others" });
      }

      // Verify employee belongs to same manager (skip if self-marking)
      if (targetEmployeeId !== req.user.employeeId) {
        const emp = await ensureSameManager(req.user, targetEmployeeId);
        if (!emp) {
          return res
            .status(403)
            .json({ error: "Cannot mark attendance for this employee" });
        }
      }

      const doc = await Attendance.findOneAndUpdate(
        { employeeId: targetEmployeeId, day },
        { $set: { present, checkIn, checkOut, hoursWorked, notes } },
        { new: true, upsert: true }
      );

      res.json(doc);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);


/**
 * Get today's attendance for all employees (admin/manager only)
 */
router.get(
  "/today",
  authMiddleware(["admin", "manager"]),
  async (req, res) => {
    try {
      const { date } = req.query;
      if (!date) return res.status(400).json({ error: "Date parameter is required" });

      const currentManagerId = getManagerId(req.user);

      // Get employees under this manager
      const allEmployees = await Employee.find({
        role: { $ne: "manager" },
        managerId: currentManagerId,
      }).select("employeeId name designation email");

      const attendanceRecords = await Attendance.find({ day: date });

      const attendanceMap = {};
      attendanceRecords.forEach((record) => {
        attendanceMap[record.employeeId] = record;
      });

      const result = allEmployees.map((employee) => {
        const attendance = attendanceMap[employee.employeeId];
        return {
          _id: attendance?._id || null,
          employeeId: employee.employeeId,
          employeeName: employee.name,
          designation: employee.designation,
          email: employee.email,
          day: date,
          present: attendance?.present || false,
          checkIn: attendance?.checkIn || null,
          checkOut: attendance?.checkOut || null,
          hoursWorked: attendance?.hoursWorked || null,
          notes: attendance?.notes || null,
        };
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * Bulk upsert attendance (admin/manager only)
 */
router.post(
  "/bulk",
  authMiddleware(["admin", "manager"]),
  async (req, res) => {
    try {
      const rows = Array.isArray(req.body) ? req.body : [];
      const currentManagerId = getManagerId(req.user);

      // Filter rows to only employees under same manager
      const filteredRows = [];
      for (const r of rows) {
        const emp = await Employee.findOne({ employeeId: r.employeeId });
        if (emp && emp.role !== "manager" && emp.managerId?.toString() === currentManagerId.toString()) {
          filteredRows.push(r);
        }
      }

      const ops = filteredRows.map((r) => ({
        updateOne: {
          filter: { employeeId: r.employeeId, day: r.day },
          update: {
            $set: {
              present: r.present,
              checkIn: r.checkIn,
              checkOut: r.checkOut,
              hoursWorked: r.hoursWorked,
              notes: r.notes,
            },
          },
          upsert: true,
        },
      }));

      const result = await Attendance.bulkWrite(ops, { ordered: false });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * Query attendance (admins/managers)
 */
router.get(
  "/",
  authMiddleware(["admin", "manager"]),
  async (req, res) => {
    try {
      const { from, to, employeeId } = req.query;
      const q = {};
      const currentManagerId = getManagerId(req.user);

      if (employeeId) q.employeeId = employeeId;
      if (from && to) q.day = { $gte: from, $lte: to };

      let docs = await Attendance.find(q).sort({ day: -1 });

      // Only include employees under this manager
      docs = await Promise.all(
        docs.filter(Boolean).map(async (a) => {
          const emp = await Employee.findOne({ employeeId: a.employeeId });
          if (!emp || emp.role === "manager") return null;
          if (emp.managerId?.toString() !== currentManagerId.toString()) return null;
          return { ...a.toObject(), employee: emp };
        })
      );

      res.json(docs.filter(Boolean));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * Employee self history
 */
router.get(
  "/me",
  authMiddleware(["employee", "manager", "admin"]),
  async (req, res) => {
    try {
      const { from, to } = req.query;
      const q = { employeeId: req.user.employeeId };

      if (from && to) q.day = { $gte: from, $lte: to };

      const docs = await Attendance.find(q).sort({ day: -1 });
      res.json(docs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
