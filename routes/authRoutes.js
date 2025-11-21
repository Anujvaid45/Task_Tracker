// const express = require('express')
// const jwt = require('jsonwebtoken');
// const bcrypt = require("bcryptjs");

// const Employee = require('../models/Employee.js')

// const router = express.Router();

// // Register
// router.post("/register", async (req, res) => {
//   try {
//     const { employeeId, name, email, password, role, designation, secret } = req.body;

//     // ✅ Check secret from .env
//     if (secret !== process.env.NEW_REGISTER_SECRET) {
//       return res.status(403).json({ error: "Unauthorized access" });
//     }

//     // ✅ Only allow manager role
//     if (role !== "manager") {
//       return res.status(400).json({ error: "Only managers can be registered" });
//     }

//     // Prevent duplicate employeeId
//     const existing = await Employee.findOne({ employeeId });
//     if (existing) {
//       return res.status(400).json({ error: "Employee ID already exists" });
//     }

//     const employee = new Employee({
//       employeeId,
//       name,
//       email,
//       password,
//       role, // will always be "manager"
//       designation,
//     });
//     await employee.save();

//     res.json({ message: "Registered successfully" });
//   } catch (err) {
//     console.log(err);
    
//     res.status(500).json({ error: err.message });
//   }
// });


// // auth routes (login)
// router.post("/login", async (req, res) => {
//   try {
//     const { email, password } = req.body;
//     const employee = await Employee.findOne({ email });
//     if (!employee) return res.status(400).json({ error: "Invalid credentials" });

//     const isMatch = await bcrypt.compare(password, employee.password);
//     if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

//     // include managerId in token
//     const token = jwt.sign(
//       {
//         id: employee._id,
//         employeeId: employee.employeeId,
//         role: employee.role,
//         managerId: employee.managerId || null
//       },
//       process.env.JWT_SECRET,
//       { expiresIn: "1d" }
//     );

//     res.json({
//       token,
//       name: employee.name,
//       role: employee.role,
//       _id: employee._id,
//       employeeId: employee.employeeId,
//       managerId: employee.managerId || null
//     });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });


// module.exports = router;


//this is oracle db code

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const oracledb = require('oracledb');

const { resolveHierarchyChain } = require("../utils/hierarchyResolver");
const router = express.Router();

router.post("/register", async (req, res) => {
  let connection;
  try {
    const {
      employeeId,
      name,
      email,
      password,
      role,
      designation,
      reportingManager, // ID of their manager, if applicable
      applicationName,
      location,
      secret,
    } = req.body;

    // 🔒 1️⃣ Check security secret
    if (secret !== process.env.NEW_REGISTER_SECRET) {
      return res.status(403).json({ error: "Unauthorized access" });
    }

    // 🔍 2️⃣ Validate required fields
    if (!employeeId || !name || !email || !password || !role) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    connection = await oracledb.getConnection();

    // 🛑 3️⃣ Prevent duplicate employee ID
    const existing = await connection.execute(
      "SELECT 1 FROM employees WHERE employee_id = :employeeId",
      { employeeId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "Employee ID already exists" });
    }

    // 🔑 4️⃣ Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // 🧩 5️⃣ Auto-resolve hierarchy if there’s a reporting manager
    let hierarchy = {};
    if (reportingManager) {
      hierarchy = await resolveHierarchyChain(connection, reportingManager);
    }

    // 🧾 6️⃣ Build parameters for insertion
    const binds = {
      employeeId,
      name,
      email,
      password: hashedPassword,
      role,
      designation: designation || null,
      reportingManager: reportingManager || null,
      applicationName: applicationName || null,
      location: location || null,
      headLtId: hierarchy.head_lt_id || null,
      ltId: hierarchy.lt_id || null,
      altId: hierarchy.alt_id || null,
    };

    // 💾 7️⃣ Insert new user
    await connection.execute(
      `
      INSERT INTO EMPLOYEES (
        employee_id, name, email, password, role, designation,
        reporting_manager, application_name, location,
        head_lt_id, lt_id, alt_id, status, created_at
      )
      VALUES (
        :employeeId, :name, :email, :password, :role, :designation,
        :reportingManager, :applicationName, :location,
        :headLtId, :ltId, :altId, 'active', SYSTIMESTAMP
      )
      `,
      binds,
      { autoCommit: true }
    );

    res.json({
      message: `Registered ${role} successfully!`,
      hierarchy,
    });
  } catch (err) {
    console.log(err)
    console.error("Registration error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 🔹 Login
router.post("/login", async (req, res) => {
  let connection;
  try {
    const { email, password } = req.body;
    connection = await oracledb.getConnection();

    const result = await connection.execute(
      "SELECT * FROM employees WHERE email = :email",
      { email },
      { outFormat: oracledb.OUT_FORMAT_OBJECT } // return as object
    );

    const employee = result.rows[0];
    if (!employee) return res.status(400).json({ error: "Invalid credentials" });

    // Compare password
    const isMatch = await bcrypt.compare(password, employee.PASSWORD);
    if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

    // Generate JWT
    const token = jwt.sign(
      {
        id: employee.ID,               // use Oracle PK
        employeeId: employee.EMPLOYEE_ID,
        role: employee.ROLE,
        managerId: employee.MANAGER_ID || null
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({
      token,
      name: employee.NAME,
      role: employee.ROLE,
      id: employee.ID,
      employeeId: employee.EMPLOYEE_ID,
      managerId: employee.MANAGER_ID || null
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

module.exports = router;
