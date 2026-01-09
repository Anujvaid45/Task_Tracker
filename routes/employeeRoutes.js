const express = require('express');
const oracledb = require('oracledb');
const authMiddleware = require('../middleware/auth.js');
const bcrypt = require('bcryptjs');
const { safeRoute } = require("../utils/dbWrapper"); // uses conn = pooled connection and closes it
const { buildVisibilityOracle } = require("../utils/visibilityOracle");

const router = express.Router();

// Helper function to execute queries
async function executeQuery(query, binds = [], options = {}) {
  let connection;
  try {
    connection = await oracledb.getConnection();
    const result = await connection.execute(query, binds, { autoCommit: true, ...options });
    
    return result;
  } finally {
    if (connection) await connection.close();
  }
}





// --------------------
// Helpers
// --------------------
function camelCase(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function toCamelCaseKeys(rows) {
  return rows.map((row) => {
    const newRow = {};
    for (const key in row) {
      newRow[camelCase(key)] = row[key];
    }
    return newRow;
  });
}

function formatDateForDisplay(d) {
  if (!d) return "-";
  if (typeof d === "string") return d;
  try {
    return d.toISOString().split("T")[0];
  } catch {
    return String(d);
  }
}

// --------------------
// CREATE Employee
// --------------------
router.post(
  "/",
  authMiddleware(["head_lt", "lt", "alt", "admin", "manager"]),
  async (req, res) => {
    return safeRoute(req, res, async (conn) => {
      const creator = req.user;

      const {
        employeeId,
        name,
        email,
        phone,
        password,
        role = "employee",
        designation,
        skills = [],
        location,
        reportingManager,
        vendorName,
        category,
        applicationName,
        dateOfJoining,
        lastWorkingDay,
        teamMemberStatus = "live",
        remarks,
        feedback,
        grade,
      } = req.body;

      // -------------------------------------------------------
      // 1️⃣ Required fields
      // -------------------------------------------------------
      if (!employeeId || !name || !email || !password) {
        return res
          .status(400)
          .json({ error: "employeeId, name, email, password are required" });
      }

      // -------------------------------------------------------
      // 2️⃣ Duplicate check
      // -------------------------------------------------------
      const dupSql = `
        SELECT employee_id, email 
        FROM employees 
        WHERE employee_id = :eid OR email = :em
      `;

      const dupRes = await conn.execute(
        dupSql,
        { eid: employeeId, em: email },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      if (dupRes.rows.length > 0) {
        const d = dupRes.rows[0];
        if (d.EMPLOYEE_ID === employeeId)
          return res.status(400).json({ error: "Employee ID already exists" });
        if (d.EMAIL === email)
          return res.status(400).json({ error: "Email already exists" });
      }

      // -------------------------------------------------------
      // 3️⃣ Core manager assignment logic EXACTLY as before
      // -------------------------------------------------------
      let managerIdToAssign = null;

      if (creator.role === "manager") {
        managerIdToAssign = creator.id;
        console.log(managerIdToAssign,"hehe")

      } else if (creator.role === "admin") {
        if (role !== "employee")
          return res.status(403).json({ error: "Admins can only create employees" });

        if (!creator.managerId)
          return res
            .status(400)
            .json({ error: "Admin is not linked to a manager" });

        managerIdToAssign = creator.managerId;

      } else {
        // head_lt, lt, alt cannot directly create employees
        return res.status(403).json({ error: "Unauthorized to create users" });
      }

      // -------------------------------------------------------
      // 4️⃣ Verify reportingManager belongs to creator's visibility tree
      // -------------------------------------------------------
      // 💥 Skip visibility check if manager is assigning themselves
if (creator.role === "manager" && Number(reportingManager) === creator.id) {
  // allowed
} else {
  // ⚡ visibility check ONLY when reportingManager is someone else
  const { sqlCondition, binds } = buildVisibilityOracle(creator, {});
  binds.rid = reportingManager;

  const visSql = `
    SELECT e.id
    FROM employees e
    WHERE e.id = :rid
    ${sqlCondition}
  `;

  const visRes = await conn.execute(visSql, binds, {
    outFormat: oracledb.OUT_FORMAT_OBJECT,
  });

  if (visRes.rows.length === 0) {
    return res.status(403).json({
      error: "You are not authorized to assign this reporting manager",
    });
  }
}


      // -------------------------------------------------------
      // 5️⃣ Insert employee
      // -------------------------------------------------------
      const hashedPassword = await bcrypt.hash(password, 10);

      const insertSql = `
        INSERT INTO employees 
          (employee_id, name, email, phone, password, role, designation, skills,
           manager_id, location, reporting_manager, vendor_name, category,
           application_name, date_of_joining, last_working_day, team_member_status,
           remarks, feedback, grade)
        VALUES 
          (:eid, :name, :email, :phone, :pass, :role, :des, :skills,
           :mgr, :loc, :rm, :vendor, :cat, :app,
           TO_DATE(:doj, 'YYYY-MM-DD'),
           TO_DATE(:lwd, 'YYYY-MM-DD'),
           :status, :remarks, :feedback, :grade)
      `;

      await conn.execute(
        insertSql,
        {
          eid: employeeId,
          name,
          email,
          phone,
          pass: hashedPassword,
          role,
          des: designation,
          skills: JSON.stringify(skills || []),
          mgr: managerIdToAssign,
          loc: location,
          rm: reportingManager || null,
          vendor: vendorName,
          cat: category,
          app: applicationName,
          doj: dateOfJoining,
          lwd: lastWorkingDay,
          status: teamMemberStatus,
          remarks,
          feedback,
          grade,
        },
        { autoCommit: true }
      );

      // -------------------------------------------------------
      // 6️⃣ Response
      // -------------------------------------------------------
      return res.json({
        employeeId,
        name,
        email,
        role,
        managerId: managerIdToAssign,
        reportingManager: reportingManager || null,
      });
    });
  }
);


// --------------------
// GET Employees
// --------------------
router.get(
  "/",
  authMiddleware(["head_lt", "lt", "alt", "admin", "manager", "employee"]),
  async (req, res) => {
    return safeRoute(req, res, async (conn) => {
      try {
        const user = req.user;

        // -------------------------------------------------------
        // 1️⃣ Build visibility SQL + binds
        // -------------------------------------------------------
        const { sqlCondition, binds } = buildVisibilityOracle(user, req.query);

        // For employees, ensure they see only themselves
        if (user.role === "employee") {
          const sql = `
            SELECT *
            FROM employees
            WHERE id = :selfId
          `;
          const result = await conn.execute(
            sql,
            { selfId: user.id },
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
          );

          return res.json(
            result.rows.map((row) => ({
              ...Object.fromEntries(
                Object.entries(row).map(([k, v]) => [camelCase(k), v])
              ),
            }))
          );
        }

        // -------------------------------------------------------
        // 2️⃣ Universal employee visibility query
        // -------------------------------------------------------
        const sql = `
          SELECT *
          FROM employees e
          WHERE 1=1
          ${sqlCondition}   -- LT/ALT/MANAGER/TL visibility rules
          ORDER BY e.name
        `;

        const result = await conn.execute(sql, binds, {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });

        const employeesRaw = result.rows;

        // -------------------------------------------------------
        // 3️⃣ Collect reporting_manager values to resolve names
        // -------------------------------------------------------
        const reportingManagerIds = [
          ...new Set(
            employeesRaw.map((emp) => emp.REPORTING_MANAGER).filter(Boolean)
          ),
        ];

        let reportingManagerMap = {};
        if (reportingManagerIds.length > 0) {
          const mgrSql = `
            SELECT id, name
            FROM employees
            WHERE id IN (${reportingManagerIds
              .map((_, i) => `:id${i}`)
              .join(",")})
          `;
          const mgrBinds = {};
          reportingManagerIds.forEach((id, idx) => {
            mgrBinds[`id${idx}`] = id;
          });

          const mgrResult = await conn.execute(mgrSql, mgrBinds, {
            outFormat: oracledb.OUT_FORMAT_OBJECT,
          });

          mgrResult.rows.forEach((mgr) => {
            reportingManagerMap[mgr.ID] = { id: mgr.ID, name: mgr.NAME };
          });
        }

        // -------------------------------------------------------
        // 4️⃣ Map final output rows
        // -------------------------------------------------------
        const employees = employeesRaw.map((emp) => {
          const {
            EMPLOYEE_ID,
            NAME,
            DESIGNATION,
            EMAIL,
            PHONE,
            ROLE,
            LOCATION,
            CATEGORY,
            APPLICATION_NAME,
            REPORTING_MANAGER,
            GRADE,
            SKILLS,
            DATE_OF_JOINING,
            LAST_WORKING_DAY,
            ...rest
          } = emp;

          return {
            employeeId: EMPLOYEE_ID,
            name: NAME,
            designation: DESIGNATION,
            email: EMAIL,
            phone: PHONE,
            role: ROLE,
            location: LOCATION,
            category: CATEGORY,
            applicationName: APPLICATION_NAME,
            reportingManager:
              reportingManagerMap[REPORTING_MANAGER] || {
                id: REPORTING_MANAGER || null,
                name: "-",
              },
            grade: GRADE,
            skills: SKILLS ? JSON.parse(SKILLS || "[]") : [],
            dateOfJoining: DATE_OF_JOINING
              ? formatDateForDisplay(DATE_OF_JOINING)
              : "-",
            lastWorkingDay: LAST_WORKING_DAY
              ? formatDateForDisplay(LAST_WORKING_DAY)
              : "-",
            ...Object.fromEntries(
              Object.entries(rest).map(([k, v]) => [camelCase(k), v])
            ),
          };
        });
        console.log("GET /employees returned", employees);
        return res.json(employees);
      } catch (err) {
        console.error("GET /employees failed:", err);
        throw err;
      }
    });
  }
);


// --------------------
// DELETE Employee
// --------------------
router.delete(
  "/:id",
  authMiddleware(["head_lt", "lt", "alt", "admin", "manager"]),
  async (req, res) => {
    return safeRoute(req, res, async (conn) => {
      const { id } = req.params;
      const user = req.user;

      // -------------------------------------------------------
      // 1️⃣ Fetch employee being deleted
      // -------------------------------------------------------
      const empSql = `
        SELECT *
        FROM employees
        WHERE id = :id
      `;
      const empRes = await conn.execute(empSql, { id }, { outFormat: oracledb.OUT_FORMAT_OBJECT });

      if (empRes.rows.length === 0) {
        return res.status(404).json({ error: "Employee not found" });
      }

      const employee = empRes.rows[0];

      // -------------------------------------------------------
      // 2️⃣ Visibility-based security check
      //    (except special cases below)
      // -------------------------------------------------------
      const { sqlCondition, binds } = buildVisibilityOracle(user, {});
      binds.targetId = id;

      const visSql = `
        SELECT id 
        FROM employees e
        WHERE e.id = :targetId
        ${sqlCondition}
      `;

      const visRes = await conn.execute(visSql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      if (visRes.rows.length === 0) {
        return res.status(403).json({
          error: "You are not authorized to delete this employee",
        });
      }

      // -------------------------------------------------------
      // 3️⃣ Special mandatory authorization rules
      // -------------------------------------------------------

      // ADMIN → may delete ONLY employees owned by their manager
      if (user.role === "admin") {
        if (employee.MANAGER_ID !== user.managerId) {
          return res.status(403).json({
            error: "Admins can only delete employees under their manager",
          });
        }
      }

      // MANAGER → strict rules
      if (user.role === "manager") {
        // Manager may delete admin or employee — ONLY if manager_id matches
        if (["admin", "employee"].includes(employee.ROLE)) {
          if (employee.MANAGER_ID !== user.id) {
            return res.status(403).json({
              error: `Cannot delete this ${employee.ROLE}`,
            });
          }
        } else {
          // Manager may NOT delete LT, ALT, head_lt, manager
          return res.status(403).json({ error: "Unauthorized to delete this user" });
        }
      }

      // -------------------------------------------------------
      // 4️⃣ Clean up subordinate references
      // -------------------------------------------------------
      await conn.execute(
        `UPDATE employees SET reporting_manager = NULL WHERE reporting_manager = :id`,
        { id },
        { autoCommit: true }
      );

      // -------------------------------------------------------
      // 5️⃣ Delete employee
      // -------------------------------------------------------
      await conn.execute(
        `DELETE FROM employees WHERE id = :id`,
        { id },
        { autoCommit: true }
      );

      return res.json({ message: "Employee deleted successfully" });
    });
  }
);


// --------------------
// UPDATE Employee
// --------------------
router.put(
  "/:id",
  authMiddleware(["head_lt", "lt", "alt", "admin", "manager", "employee"]),
  async (req, res) => {
    return safeRoute(req, res, async (conn) => {
      const creator = req.user;
      const { id } = req.params;
      const body = req.body;

      // Column mapping
      const columnMap = {
        employeeId: "EMPLOYEE_ID",
        name: "NAME",
        designation: "DESIGNATION",
        phone: "PHONE",
        email: "EMAIL",
        password: "PASSWORD",
        role: "ROLE",
        status: "STATUS",
        managerId: "MANAGER_ID",
        location: "LOCATION",
        reportingManager: "REPORTING_MANAGER",
        vendorName: "VENDOR_NAME",
        category: "CATEGORY",
        applicationName: "APPLICATION_NAME",
        dateOfJoining: "DATE_OF_JOINING",
        lastWorkingDay: "LAST_WORKING_DAY",
        teamMemberStatus: "TEAM_MEMBER_STATUS",
        remarks: "REMARKS",
        feedback: "FEEDBACK",
        grade: "GRADE",
        skills: "SKILLS",
      };

      // -----------------------------------------------------------
      // 1️⃣ Fetch employee being updated
      // -----------------------------------------------------------
      const empResult = await conn.execute(
        `SELECT * FROM employees WHERE id = :id`,
        { id },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      if (empResult.rows.length === 0)
        return res.status(404).json({ error: "Employee not found" });

      const employee = empResult.rows[0];

      // -----------------------------------------------------------
      // 2️⃣ EMPLOYEE ROLE SPECIAL CASE
      // -----------------------------------------------------------
      if (creator.role === "employee") {
        if (creator.id !== Number(id)) {
          return res
            .status(403)
            .json({ error: "Unauthorized to update other employees" });
        }

        // Employees can update ONLY skills
        if (!("skills" in body)) {
          return res
            .status(400)
            .json({ error: "Employees can only update their skills" });
        }

        await conn.execute(
          `UPDATE employees SET SKILLS = :skills WHERE id = :id`,
          { skills: JSON.stringify(body.skills || []), id },
          { autoCommit: true }
        );

        return res.json({ message: "Skills updated successfully" });
      }

      // -----------------------------------------------------------
      // 3️⃣ Visibility Security Check (Universal)
      // -----------------------------------------------------------
      const { sqlCondition, binds } = buildVisibilityOracle(creator, {});
      binds.targetId = id;

      const visSql = `
        SELECT e.id
        FROM employees e
        WHERE e.id = :targetId
        ${sqlCondition}
      `;

      const visRes = await conn.execute(visSql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      if (visRes.rows.length === 0) {
        return res.status(403).json({
          error: "You are not authorized to update this employee",
        });
      }

      // -----------------------------------------------------------
      // 4️⃣ Manager/Admin Permission Rules
      // -----------------------------------------------------------
      if (creator.role === "manager" && employee.MANAGER_ID !== creator.id) {
        return res
          .status(403)
          .json({ error: "Managers can update only their direct employees" });
      }

      if (creator.role === "admin" && employee.ROLE !== "employee") {
        return res
          .status(403)
          .json({ error: "Admins can only update employees" });
      }

      // -----------------------------------------------------------
      // 5️⃣ Duplicate checks (employeeId, email)
      // -----------------------------------------------------------
      if (body.employeeId && body.employeeId !== employee.EMPLOYEE_ID) {
        const dup = await conn.execute(
          `SELECT employee_id FROM employees WHERE employee_id = :eid`,
          { eid: body.employeeId },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        if (dup.rows.length > 0)
          return res.status(400).json({ error: "Employee ID already exists" });
      }

      if (body.email && body.email !== employee.EMAIL) {
        const dup = await conn.execute(
          `SELECT email FROM employees WHERE email = :email`,
          { email: body.email },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        if (dup.rows.length > 0)
          return res.status(400).json({ error: "Email already exists" });
      }

      // -----------------------------------------------------------
      // 6️⃣ Validate reportingManager using visibility oracle
      // -----------------------------------------------------------
      if (body.reportingManager) {
        const { sqlCondition: rmCond, binds: rmBinds } =
          buildVisibilityOracle(creator, {});

        rmBinds.rmId = body.reportingManager;

        const rmSql = `
          SELECT e.id
          FROM employees e
          WHERE id = :rmId
          ${rmCond}
        `;

        const rmRes = await conn.execute(rmSql, rmBinds, {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });

        if (rmRes.rows.length === 0) {
          return res.status(403).json({
            error: "You are not authorized to assign this reporting manager",
          });
        }
      }

      // -----------------------------------------------------------
      // 7️⃣ Build UPDATE Query Dynamically
      // -----------------------------------------------------------
      const fields = {};
      const setClauses = [];

      for (const [key, value] of Object.entries(body)) {
        const column = columnMap[key];
        if (value !== undefined && column) {
          if (key === "skills") {
            setClauses.push(`${column} = :${key}`);
            fields[key] = JSON.stringify(value || []);
          } else {
            setClauses.push(`${column} = :${key}`);
            fields[key] = value;
          }
        }
      }

      if (setClauses.length > 0) {
        fields.id = id;
        const updateQuery = `
          UPDATE employees 
          SET ${setClauses.join(", ")}
          WHERE id = :id
        `;

        await conn.execute(updateQuery, fields, { autoCommit: true });
      }

      return res.json({ message: "Employee updated successfully" });
    });
  }
);


// --------------------
// GET /employees/reporting-managers
// --------------------
router.get("/reporting-managers", authMiddleware(["admin", "manager"]), async (req, res) => {
  try {
    const creator = req.user; // { id, role, managerId }
    let managers = [];

    if (creator.role === "manager") {
      // Manager → self + their sub-managers
      const selfResult = await executeQuery(
        `SELECT id, employee_id, name, role 
         FROM employees 
         WHERE id = :id`,
        [creator.id],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const subResult = await executeQuery(
        `SELECT id, employee_id, name, role 
         FROM employees 
         WHERE role IN ('admin','manager') AND manager_id = :id`,
        [creator.id],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const selfManager = selfResult.rows?.[0] || null;
      const subManagers = subResult.rows || [];

      managers = [
        ...(selfManager ? [selfManager] : []),
        ...subManagers
      ];

    } else if (creator.role === "admin") {
      if (!creator.managerId) {
        return res.status(400).json({ error: "Admin is not linked to a manager" });
      }

      // Admin → self + linked manager + sub-managers under that manager
      const selfResult = await executeQuery(
        `SELECT id, employee_id, name, role 
         FROM employees 
         WHERE id = :id`,
        [creator.id],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const linkedResult = await executeQuery(
        `SELECT id, employee_id, name, role 
         FROM employees 
         WHERE id = :mid`,
        [creator.managerId],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const subResult = await executeQuery(
        `SELECT id, employee_id, name, role 
         FROM employees 
         WHERE role IN ('admin','manager') AND manager_id = :mid AND id != :aid`,
        [creator.managerId, creator.id],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const selfAdmin = selfResult.rows?.[0] || null;
      const linkedManager = linkedResult.rows?.[0] || null;
      const subManagers = subResult.rows || [];

      managers = [
        ...(selfAdmin ? [selfAdmin] : []),
        ...(linkedManager ? [linkedManager] : []),
        ...subManagers
      ];

    } else {
      return res.status(403).json({ error: "Unauthorized" });
    }

    if (managers.length === 0) {
      return res.json([]); // return empty array if no managers
    }

    // Convert keys to lowercase
    const formattedManagers = managers.map(mgr => ({
      id: mgr.ID || mgr.id,
      employee_id: mgr.EMPLOYEE_ID || mgr.employee_id,
      name: mgr.NAME || mgr.name,
      role: mgr.ROLE || mgr.role
    }));

    res.json(formattedManagers);

  } catch (err) {
    console.error("Fetching reporting managers failed:", err);
    res.status(500).json({ error: err.message });
  }
});


// --------------------
// GET /employees/team-leads
// --------------------
router.get("/team-leads", authMiddleware(["head_lt", "lt", "alt", "admin", "manager"]), async (req, res) => {
  return safeRoute(req, res, async (conn) => {
    try {
      let managerId;
      if (req.user.role === "manager") {
        managerId = req.user.id;
      } else if (req.user.role === "admin") {
        managerId = req.user.managerId;
      }

      if (!managerId) {
        return res.status(400).json({ error: "Manager ID not found for user." });
      }

      const result = await conn.execute(
        `SELECT id, name FROM employees WHERE manager_id = :mid AND role = 'admin'`,
        { mid: managerId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const camelCasedResult = toCamelCaseKeys(result.rows);
      return res.json(camelCasedResult);
    } catch (err) {
      throw err;
    }
  });
});

// --------------------
// GET /employees/all
// --------------------
router.get("/all", async (req, res) => {
  return safeRoute(req, res, async (conn) => {
    const result = await conn.execute(
      `SELECT id, name, role FROM employees ORDER BY name`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return res.json(result.rows);
  });
});

// --------------------
// Skills CRUD
// --------------------
router.post("/skill", authMiddleware(["head_lt", "lt", "alt", "admin", "manager"]), async (req, res) => {
  return safeRoute(req, res, async (conn) => {
    const { skill_name, skill_description } = req.body;
    await conn.execute(
      `INSERT INTO skills (skill_name, skill_description) VALUES (:skill_name, :skill_description)`,
      { skill_name, skill_description },
      { autoCommit: true }
    );
    return res.status(201).json({ message: "Skill created successfully" });
  });
});

router.get("/skill", authMiddleware(["head_lt", "lt", "alt", "admin", "manager", "employee"]), async (req, res) => {
  return safeRoute(req, res, async (conn) => {
    const result = await conn.execute(
      `SELECT id, skill_name, skill_description, is_active FROM skills ORDER BY skill_name`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const mapped = result.rows.map((r) => ({
      id: r.ID,
      skill_name: r.SKILL_NAME,
      skill_description: r.SKILL_DESCRIPTION,
      is_active: r.IS_ACTIVE,
    }));
    return res.json(mapped);
  });
});

router.put("/skill/:id", authMiddleware(["head_lt", "lt", "alt", "admin", "manager"]), async (req, res) => {
  return safeRoute(req, res, async (conn) => {
    const { id } = req.params;
    const { skill_name, skill_description, is_active } = req.body;
    await conn.execute(
      `UPDATE skills SET skill_name = :skill_name, skill_description = :skill_description, is_active = :is_active WHERE id = :id`,
      { skill_name, skill_description, is_active, id },
      { autoCommit: true }
    );
    return res.json({ message: "Skill updated successfully" });
  });
});

router.delete("/skill/:id", authMiddleware(["head_lt", "lt", "alt", "admin", "manager"]), async (req, res) => {
  return safeRoute(req, res, async (conn) => {
    const { id } = req.params;
    await conn.execute(`DELETE FROM skills WHERE id = :id`, { id }, { autoCommit: true });
    return res.json({ message: "Skill deleted successfully" });
  });
});

// --------------------
// Application lists per-role
// --------------------

// Helper to split, trim and dedupe comma-separated app names
function extractUniqueApps(rows, columnName = "APPLICATION_NAME") {
  const seen = new Map(); // key = lowercased name -> original-case name
  for (const r of rows) {
    const val = r[columnName];
    if (!val) continue;
    // split on comma, also tolerate other separators (strict comma here)
    val.split(",").forEach((raw) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) seen.set(key, trimmed);
    });
  }
  // return sorted array (case-insensitive)
  return Array.from(seen.values()).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
}

// Manager scoped
router.get(
  "/applications",
  authMiddleware(["manager"]),
  async (req, res) => {
    return safeRoute(req, res, async (conn) => {
      // 1) apps from employees under this manager
      const underRes = await conn.execute(
        `SELECT DISTINCT application_name FROM employees WHERE manager_id = :managerId`,
        { managerId: req.user.id },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      // 2) apps recorded on manager's own row (if any)
      const selfRes = await conn.execute(
        `SELECT application_name FROM employees WHERE id = :managerId`,
        { managerId: req.user.id },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      // combine rows from both queries
      const combinedRows = [
        ...(underRes.rows || []),
        ...(selfRes.rows || [])
      ];

      const apps = extractUniqueApps(combinedRows, "APPLICATION_NAME");

      return res.json(apps);
    });
  }
);

// ALT scoped
router.get("/applications/alt", authMiddleware(["alt"]), async (req, res) => {
  return safeRoute(req, res, async (conn) => {
    const result = await conn.execute(
      `SELECT DISTINCT application_name FROM employees WHERE alt_id = :altId`,
      { altId: req.user.id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const apps = extractUniqueApps(result.rows);
    return res.json(apps);
  });
});

// LT scoped
router.get("/applications/lt", authMiddleware(["lt"]), async (req, res) => {
  return safeRoute(req, res, async (conn) => {
    const result = await conn.execute(
      `SELECT DISTINCT application_name FROM employees WHERE lt_id = :ltId`,
      { ltId: req.user.id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const apps = extractUniqueApps(result.rows);
    return res.json(apps);
  });
});

// Head_LT / all scoped
router.get("/applications/all", authMiddleware(["head_lt"]), async (req, res) => {
  return safeRoute(req, res, async (conn) => {
    const result = await conn.execute(
      `SELECT DISTINCT application_name FROM employees WHERE application_name IS NOT NULL`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const apps = extractUniqueApps(result.rows);
    return res.json(apps);
  });
});


// --------------------
// Hierarchy endpoint (for selects)
// --------------------
router.get("/hierarchy", authMiddleware(), async (req, res) => {
  return safeRoute(req, res, async (conn) => {
    const { level, ltId, altId, managerId } = req.query;

    let sql = "";
    const binds = {};

    switch (level) {
      case "lt":
        sql = `
          SELECT id, name
          FROM employees
          WHERE role = 'lt'
          ORDER BY name
        `;
        break;

      case "alt":
        sql = `
          SELECT id, name
          FROM employees
          WHERE reporting_manager = :ltId
            AND role = 'alt'
          ORDER BY name
        `;
        binds.ltId = Number(ltId);
        break;

      case "manager":
        sql = `
          SELECT id, name, application_name
          FROM employees
          WHERE reporting_manager = :altId
            AND role = 'manager'
          ORDER BY name
        `;
        binds.altId = Number(altId);
        break;

      case "tl":
        sql = `
          SELECT id, name
          FROM employees
          WHERE reporting_manager = :managerId
            AND role = 'admin'
          ORDER BY name
        `;
        binds.managerId = Number(managerId);
        break;

      default:
        return res.status(400).json({ error: "Invalid hierarchy level" });
    }

    const result = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    // Some callers expect { list: [...] }
    return res.json({ list: result.rows });
  });
});

module.exports = router;
