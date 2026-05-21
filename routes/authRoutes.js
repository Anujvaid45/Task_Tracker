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
      reportingManager,
      applicationName,
      location,
      secret,
    } = req.body;

    // 🔒 1️⃣ Security check
    if (secret !== process.env.NEW_REGISTER_SECRET) {
      return res.status(403).json({ error: "Unauthorized access" });
    }

    // 🔍 2️⃣ Validation
    if (!employeeId || !name || !email || !password || !role) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    connection = await oracledb.getConnection();

    // 🛑 3️⃣ Duplicate check
    const existing = await connection.execute(
      `SELECT 1 FROM employees WHERE employee_id = :employeeId`,
      { employeeId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "Employee ID already exists" });
    }

    // 🔑 4️⃣ Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // 🧩 5️⃣ Resolve hierarchy
    let hierarchy = {};
    if (reportingManager) {
      hierarchy = await resolveHierarchyChain(connection, reportingManager);
    }

    // ---------------------------------------------------------
    // 🔹 6️⃣ Handle MULTIPLE Applications
    // ---------------------------------------------------------
    let applicationIds = [];

    if (applicationName && applicationName !== "all") {
      const apps = [
        ...new Set(
          applicationName
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean)
        ),
      ];

      for (const app of apps) {
        // 🔍 Check if application exists
        const appCheck = await connection.execute(
          `SELECT id FROM applications WHERE LOWER(name) = LOWER(:name)`,
          { name: app },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        let appId;

        if (appCheck.rows.length > 0) {
          appId = appCheck.rows[0].ID;
        } else {
          // ➕ Insert new application
          const insertApp = await connection.execute(
            `INSERT INTO applications (id, name)
             VALUES (applications_seq.NEXTVAL, :name)
             RETURNING id INTO :id`,
            {
              name: app,
              id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
            }
          );

          appId = insertApp.outBinds.id[0];
        }

        applicationIds.push(appId);
      }
    }

    // ---------------------------------------------------------
    // 🔹 7️⃣ Insert Employee
    // ---------------------------------------------------------
    const normalizedApplicationName = applicationName
      ? applicationName
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean)
          .join(",")
      : null;

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
      {
        employeeId,
        name,
        email,
        password: hashedPassword,
        role,
        designation: designation || null,
        reportingManager: reportingManager || null,
        applicationName: normalizedApplicationName,
        location: location || null,
        headLtId: hierarchy.head_lt_id || null,
        ltId: hierarchy.lt_id || null,
        altId: hierarchy.alt_id || null,
      }
    );

    // ---------------------------------------------------------
    // 🔹 8️⃣ Get inserted employee PK
    // ---------------------------------------------------------
    const empResult = await connection.execute(
      `SELECT id FROM employees WHERE employee_id = :employeeId`,
      { employeeId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const empId = empResult.rows[0].ID;

    // ---------------------------------------------------------
    // 🔹 9️⃣ Insert into employee_applications (NO DUPLICATES)
    // ---------------------------------------------------------
    for (const appId of applicationIds) {
      await connection.execute(
        `
        INSERT INTO employee_applications (employee_id, application_id)
        SELECT :empId, :appId FROM dual
        WHERE NOT EXISTS (
          SELECT 1 FROM employee_applications
          WHERE employee_id = :empId AND application_id = :appId
        )
        `,
        { empId, appId }
      );
    }

    // ---------------------------------------------------------
    // 🔹 🔟 Commit transaction
    // ---------------------------------------------------------
    await connection.commit();

    res.json({
      message: `Registered ${role} successfully!`,
      hierarchy,
    });

  } catch (err) {
    console.error("Registration error:", err);

    if (connection) {
      try {
        await connection.rollback();
      } catch (e) {}
    }

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
