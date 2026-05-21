const express = require('express');
const oracledb = require('oracledb');
const authMiddleware = require('../middleware/auth.js');
const bcrypt = require('bcryptjs');
const { safeRoute } = require("../utils/dbWrapper"); // uses conn = pooled connection and closes it
const { buildVisibilityOracle } = require("../utils/visibilityOracle");
const {resolveHierarchyChain} = require("../utils/hierarchyResolver.js");

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

// Helpers
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

// CREATE Employee
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
        applicationId,
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
      const dupRes = await conn.execute(
        `SELECT employee_id, email FROM employees WHERE employee_id = :eid OR email = :em`,
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
      // 3️⃣ Manager assignment (same as before)
      // -------------------------------------------------------
      let managerIdToAssign = null;

      if (creator.role === "manager") {
        managerIdToAssign = creator.id;
      } else if (creator.role === "admin") {
        if (role !== "employee")
          return res.status(403).json({ error: "Admins can only create employees" });

        if (!creator.managerId)
          return res.status(400).json({ error: "Admin not linked to manager" });

        managerIdToAssign = creator.managerId;
      } else {
        return res.status(403).json({ error: "Unauthorized to create users" });
      }

      // -------------------------------------------------------
      // 4️⃣ Visibility check
      // -------------------------------------------------------
      if (!(creator.role === "manager" && Number(reportingManager) === creator.id)) {
        const { sqlCondition, binds } = buildVisibilityOracle(creator, {});
        binds.rid = reportingManager;

        const visRes = await conn.execute(
          `SELECT e.id FROM employees e WHERE e.id = :rid ${sqlCondition}`,
          binds,
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        if (visRes.rows.length === 0) {
          return res.status(403).json({
            error: "You are not authorized to assign this reporting manager",
          });
        }
      }

      // -------------------------------------------------------
// 🔥 5️⃣ HANDLE MULTIPLE APPLICATIONS (FIXED)
// -------------------------------------------------------
let applicationIds = [];

console.log(
  "Received applicationName:",
  applicationName,
  "Received applicationId:",
  applicationId
);

if (applicationName || applicationId) {
  // applicationName contains IDs (comma-separated)
  const idsFromName = applicationName
    ? applicationName
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .map(Number)
        .filter((id) => !isNaN(id))
    : [];

  applicationIds.push(...idsFromName);

  // also support single dropdown
  if (applicationId && applicationId !== "all") {
    const singleId = Number(applicationId);
    if (!isNaN(singleId)) {
      applicationIds.push(singleId);
    }
  }

  // remove duplicates
  applicationIds = [...new Set(applicationIds)];
}
      // -------------------------------------------------------
      // 6️⃣ Insert employee
      // -------------------------------------------------------
      const hashedPassword = await bcrypt.hash(password, 10);

// Convert application IDs → names
let normalizedApplicationName = null;

if (applicationName) {
  const appIds = applicationName
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map(Number)
    .filter((id) => !isNaN(id));

  if (appIds.length > 0) {
    const result = await conn.execute(
      `SELECT name FROM applications WHERE id IN (${appIds.map((_, i) => `:id${i}`).join(",")})`,
      Object.fromEntries(appIds.map((id, i) => [`id${i}`, id])),
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const names = result.rows.map((row) => row.NAME);

    normalizedApplicationName = names.join(",");
  }
}

      await conn.execute(
        `
        INSERT INTO employees (
          employee_id, name, email, phone, password, role, designation, skills,
          manager_id, location, reporting_manager, vendor_name, category,
          application_name, date_of_joining, last_working_day,
          team_member_status, remarks, feedback, grade
        )
        VALUES (
          :eid, :name, :email, :phone, :pass, :role, :des, :skills,
          :mgr, :loc, :rm, :vendor, :cat, :app,
          TO_DATE(:doj, 'YYYY-MM-DD'),
          TO_DATE(:lwd, 'YYYY-MM-DD'),
          :status, :remarks, :feedback, :grade
        )
        `,
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
          app: normalizedApplicationName,
          doj: dateOfJoining,
          lwd: lastWorkingDay,
          status: teamMemberStatus,
          remarks,
          feedback,
          grade,
        }
      );

      // -------------------------------------------------------
      // 7️⃣ Get employee PK
      // -------------------------------------------------------
      const empRes = await conn.execute(
        `SELECT id FROM employees WHERE employee_id = :eid`,
        { eid: employeeId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const empId = empRes.rows[0].ID;

      // -------------------------------------------------------
      // 🔥 8️⃣ Insert mapping
      // -------------------------------------------------------
      for (const appId of applicationIds) {
        await conn.execute(
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

      // -------------------------------------------------------
      // 9️⃣ Commit
      // -------------------------------------------------------
      await conn.commit();

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

// GET Employees
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
        // 🔍 DEBUG: log final SQL + binds


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
// 🔹 APPLICATION ID → NAME mapping
// -------------------------------------------------------
const applicationIds = [
  ...new Set(
    employeesRaw.map((emp) => emp.APPLICATION_ID).filter(Boolean)
  ),
];
let applicationMap = {};

if (applicationIds.length > 0) {
  const appSql = `
    SELECT id, name
    FROM applications
    WHERE id IN (${applicationIds.map((_, i) => `:app${i}`).join(",")})
  `;

  const appBinds = {};
  applicationIds.forEach((id, idx) => {
    appBinds[`app${idx}`] = id;
  });

  const appResult = await conn.execute(appSql, appBinds, {
    outFormat: oracledb.OUT_FORMAT_OBJECT,
  });

  appResult.rows.forEach((app) => {
    applicationMap[app.ID] = app.NAME;
  });
}

        // -------------------------------------------------------
        // 3️⃣ Collect reporting_manager values to resolve names
        // -------------------------------------------------------
const reportingManagerIds = [
  ...new Set(
    employeesRaw
      .map((emp) => Number(emp.REPORTING_MANAGER))
      .filter((id) => !!id)
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
            TEAM_MEMBER_STATUS,
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
            applicationId: emp.APPLICATION_ID || null,

applicationName:
  APPLICATION_NAME ||
  applicationMap[emp.APPLICATION_ID] ||
  "-",

reportingManager: REPORTING_MANAGER
  ? reportingManagerMap[REPORTING_MANAGER] || {
      id: REPORTING_MANAGER,
      name: "Unknown",
    }
  : null,
            grade: GRADE,
            skills: SKILLS ? JSON.parse(SKILLS || "[]") : [],
            dateOfJoining: DATE_OF_JOINING
              ? formatDateForDisplay(DATE_OF_JOINING)
              : "-",
              teamMemberStatus:TEAM_MEMBER_STATUS || "-",
            lastWorkingDay: LAST_WORKING_DAY
              ? formatDateForDisplay(LAST_WORKING_DAY)
              : "-",
            ...Object.fromEntries(
              Object.entries(rest).map(([k, v]) => [camelCase(k), v])
            ),
          };
        });
        return res.json(employees);
      } catch (err) {
        console.error("GET /employees failed:", err);
        throw err;
      }
    });
  }
);

// DELETE Employee
router.delete(
  "/:id",
  authMiddleware(["head_lt", "lt", "alt", "admin", "manager"]),
  async (req, res) => {
    return safeRoute(req, res, async (conn) => {
      const { id } = req.params;
      const user = req.user;

      try {
        // -------------------------------------------------------
        // 1️⃣ Fetch employee
        // -------------------------------------------------------
        const empRes = await conn.execute(
          `SELECT * FROM employees WHERE id = :id`,
          { id },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        if (empRes.rows.length === 0) {
          return res.status(404).json({ error: "Employee not found" });
        }

        const employee = empRes.rows[0];

        // -------------------------------------------------------
        // 2️⃣ Visibility check
        // -------------------------------------------------------
        const { sqlCondition, binds } = buildVisibilityOracle(user, {});
        binds.targetId = id;

        const visRes = await conn.execute(
          `
          SELECT id FROM employees e
          WHERE e.id = :targetId
          ${sqlCondition}
          `,
          binds,
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        if (visRes.rows.length === 0) {
          return res.status(403).json({
            error: "You are not authorized to delete this employee",
          });
        }

        // -------------------------------------------------------
        // 3️⃣ Role rules
        // -------------------------------------------------------
        if (user.role === "admin") {
          if (employee.MANAGER_ID !== user.managerId) {
            return res.status(403).json({
              error: "Admins can only delete employees under their manager",
            });
          }
        }

        if (user.role === "manager") {
          if (["admin", "employee"].includes(employee.ROLE)) {
            if (employee.MANAGER_ID !== user.id) {
              return res.status(403).json({
                error: `Cannot delete this ${employee.ROLE}`,
              });
            }
          } else {
            return res.status(403).json({
              error: "Unauthorized to delete this user",
            });
          }
        }

        // -------------------------------------------------------
        // 🔥 4️⃣ DELETE MAPPINGS FIRST (IMPORTANT)
        // -------------------------------------------------------
        await conn.execute(
          `DELETE FROM employee_applications WHERE employee_id = :id`,
          { id }
        );

        // -------------------------------------------------------
        // 🔹 5️⃣ Clean reporting references
        // -------------------------------------------------------
        await conn.execute(
          `UPDATE employees SET reporting_manager = NULL WHERE reporting_manager = :id`,
          { id }
        );

        // -------------------------------------------------------
        // 🔹 6️⃣ Delete employee
        // -------------------------------------------------------
        await conn.execute(
          `DELETE FROM employees WHERE id = :id`,
          { id }
        );

        // -------------------------------------------------------
        // 🔹 7️⃣ Commit
        // -------------------------------------------------------
        await conn.commit();

        return res.json({ message: "Employee deleted successfully" });

      } catch (err) {
        console.error("Delete error:", err);

        try {
          await conn.rollback();
        } catch (e) {}

        return res.status(500).json({ error: err.message });
      }
    });
  }
);

//EMPLOYEE UPDATE
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
      // 1️⃣ Fetch employee
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
      // 2️⃣ Employee role restriction
      // -----------------------------------------------------------
      if (creator.role === "employee") {
        if (creator.id !== Number(id)) {
          return res.status(403).json({ error: "Unauthorized" });
        }

        if (!("skills" in body)) {
          return res.status(400).json({
            error: "Employees can only update their skills",
          });
        }

        await conn.execute(
          `UPDATE employees SET SKILLS = :skills WHERE id = :id`,
          { skills: JSON.stringify(body.skills || []), id },
          { autoCommit: true }
        );

        return res.json({ message: "Skills updated successfully" });
      }

      // -----------------------------------------------------------
      // 3️⃣ Visibility check
      // -----------------------------------------------------------
      const { sqlCondition, binds } = buildVisibilityOracle(creator, {});
      binds.targetId = id;

      const visRes = await conn.execute(
        `SELECT e.id FROM employees e WHERE e.id = :targetId ${sqlCondition}`,
        binds,
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      if (visRes.rows.length === 0) {
        return res.status(403).json({
          error: "Not authorized to update this employee",
        });
      }

// -----------------------------------------------------------
// 🔥 Role assignment validation
// -----------------------------------------------------------
if (body.role && body.role !== employee.ROLE) {

  const allowedRoleMap = {
    head_lt: ["lt", "alt", "manager", "admin", "employee"],
    lt: ["alt", "manager", "admin", "employee"],
    alt: ["manager", "admin", "employee"],
    manager: ["admin", "employee"],
    admin: ["employee"],
  };

  const allowedRoles = allowedRoleMap[creator.role] || [];

  if (!allowedRoles.includes(body.role)) {
    return res.status(403).json({
      error: `You cannot assign role '${body.role}'`
    });
  }
}

      // -----------------------------------------------------------
      // 4️⃣ Manager/Admin restrictions
      // -----------------------------------------------------------
      if (creator.role === "manager" && employee.MANAGER_ID !== creator.id) {
        return res.status(403).json({
          error: "Managers can update only their employees",
        });
      }

      if (creator.role === "admin" && employee.ROLE !== "employee") {
        return res.status(403).json({
          error: "Admins can only update employees",
        });
      }

      // -----------------------------------------------------------
      // 5️⃣ Duplicate checks
      // -----------------------------------------------------------
      if (body.employeeId && body.employeeId !== employee.EMPLOYEE_ID) {
        const dup = await conn.execute(
          `SELECT 1 FROM employees WHERE employee_id = :eid`,
          { eid: body.employeeId }
        );
        if (dup.rows.length > 0)
          return res.status(400).json({ error: "Employee ID exists" });
      }

      if (body.email && body.email !== employee.EMAIL) {
        const dup = await conn.execute(
          `SELECT 1 FROM employees WHERE email = :email`,
          { email: body.email }
        );
        if (dup.rows.length > 0)
          return res.status(400).json({ error: "Email exists" });
      }

      // -----------------------------------------------------------
      // 6️⃣ Validate reporting manager
      // -----------------------------------------------------------
      if (
        body.reportingManager !== undefined &&
        body.reportingManager !== employee.REPORTING_MANAGER
      ) {
        const { sqlCondition: rmCond, binds: rmBinds } =
          buildVisibilityOracle(creator, {});
        rmBinds.rmId = body.reportingManager;

        const rmRes = await conn.execute(
          `SELECT id FROM employees e WHERE id = :rmId ${rmCond}`,
          rmBinds
        );

        if (rmRes.rows.length === 0) {
          return res.status(403).json({
            error: "Invalid reporting manager",
          });
        }
      }

      // -----------------------------------------------------------
// 🔥 Recalculate hierarchy if reporting manager changes
// -----------------------------------------------------------
if (
  body.reportingManager !== undefined &&
  body.reportingManager !== employee.REPORTING_MANAGER
) {

  const hierarchy = await resolveHierarchyChain(
    conn,
    body.reportingManager
  );

  body.headLtId = hierarchy.head_lt_id || null;
  body.ltId = hierarchy.lt_id || null;
  body.altId = hierarchy.alt_id || null;

  // add mappings dynamically
  columnMap.headLtId = "HEAD_LT_ID";
  columnMap.ltId = "LT_ID";
  columnMap.altId = "ALT_ID";
}
      // -----------------------------------------------------------
      // 🔥 FIX: Extract IDs + convert to names
      // -----------------------------------------------------------
      let applicationIds = [];

      if (body.applicationName !== undefined) {
        applicationIds = body.applicationName
          ? body.applicationName
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean)
              .map(Number)
              .filter((id) => !isNaN(id))
          : [];

        if (applicationIds.length > 0) {
          const result = await conn.execute(
            `SELECT id, name FROM applications 
             WHERE id IN (${applicationIds
               .map((_, i) => `:id${i}`)
               .join(",")})`,
            Object.fromEntries(
              applicationIds.map((id, i) => [`id${i}`, id])
            ),
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
          );

          const names = result.rows.map((r) => r.NAME);
          body.applicationName = names.join(",");
        } else {
          body.applicationName = null;
        }
      }

      // -----------------------------------------------------------
      // 7️⃣ Dynamic UPDATE
      // -----------------------------------------------------------
      const fields = {};
      const setClauses = [];

      for (const [key, value] of Object.entries(body)) {
        const column = columnMap[key];
        if (value !== undefined && column) {
          setClauses.push(`${column} = :${key}`);
          fields[key] =
            key === "skills" ? JSON.stringify(value || []) : value;
        }
      }

      if (setClauses.length > 0) {
        fields.id = id;

        await conn.execute(
          `UPDATE employees SET ${setClauses.join(", ")} WHERE id = :id`,
          fields,
          { autoCommit: true }
        );
      }

      // -----------------------------------------------------------
      // 🔥 FIX: Update mapping table using IDs
      // -----------------------------------------------------------
      if (body.applicationName !== undefined) {
        await conn.execute(
          `DELETE FROM employee_applications WHERE employee_id = :id`,
          { id }
        );

        for (const appId of applicationIds) {
          await conn.execute(
            `INSERT INTO employee_applications (employee_id, application_id)
             VALUES (:empId, :appId)`,
            { empId: id, appId }
          );
        }

        await conn.commit();
      }

      return res.json({ message: "Employee updated successfully" });
    });
  }
);

//REPORTING MANAGER LIST 
router.get(
  "/reporting-managers",
  authMiddleware(["head_lt", "lt", "alt", "admin", "manager", "employee"]),
  async (req, res) => {
    try {
      const user = req.user;

      let sql;
      let binds = {};

      if (user.role === "employee") {
  sql = `
    SELECT m.id, m.employee_id, m.name, m.role
    FROM employees e
    JOIN employees m ON m.id = e.reporting_manager
    WHERE e.id = :empId
  `;
  binds.empId = user.id;

} else {
  sql = `
    SELECT e.id, e.employee_id, e.name, e.role
    FROM employees e
    WHERE e.role IN ('head_lt', 'lt', 'alt', 'admin', 'manager')
    ORDER BY e.name
  `;

  binds = {};
}
      const result = await executeQuery(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      const managers = result.rows.map((mgr) => ({
        id: mgr.ID,
        employee_id: mgr.EMPLOYEE_ID,
        name: mgr.NAME,
        role: mgr.ROLE,
      }));
      res.json(managers);
    } catch (err) {
      console.error("Fetching reporting managers failed:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// GET /employees/team-leads
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

// GET /employees/all
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

// Skills CRUD
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

// Application lists per-role
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


//updated one 
router.get(
  "/applicationsnewold",
  authMiddleware(["manager", "admin","alt","lt","head_lt"]), // admin = TL in your system
  async (req, res) => {
    return safeRoute(req, res, async (conn) => {
      // 🔐 Resolve owning manager
      const managerId =
        req.user.role === "manager"
          ? Number(req.user.id)
          : Number(req.user.managerId);

      if (!managerId) {
        return res.status(400).json({ error: "Manager ID not found" });
      }

      // ✅ Phase-1 authoritative query
      const result = await conn.execute(
        `
        SELECT a.id, a.name
        FROM applications a
        JOIN employee_applications ea
          ON ea.application_id = a.id
        WHERE ea.employee_id = :managerId
        ORDER BY a.name
        `,
        { managerId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return res.json(result.rows || []);
    });
  }
);


//fully updated one

router.get(
  "/applicationsnew",
  authMiddleware(["manager", "admin", "alt", "lt", "head_lt", "employee"]),
  async (req, res) => {
    return safeRoute(req, res, async (conn) => {
      const user = req.user;
      const { sqlCondition, binds } = buildVisibilityOracle(user, req.query);

      let where = "";
      let finalBinds = {};

      /* ---------------------------------------------------------
         1️⃣ TL Special Handling
      --------------------------------------------------------- */

      if (user.role === "admin") {
        // TL → show applications of his manager
        where = `
          WHERE ea.employee_id = (
            SELECT manager_id
            FROM employees
            WHERE id = :currentUserId
          )
        `;
        finalBinds.currentUserId = user.id;

      } else {
        // Normal subtree visibility
        where = `
          WHERE e.id IN (
            SELECT e.id
            FROM employees e
            WHERE 1=1
            ${sqlCondition}
          )
        `;
        finalBinds = { ...binds };
      }

      /* ---------------------------------------------------------
         2️⃣ Query
      --------------------------------------------------------- */

      const query = `
        SELECT DISTINCT a.id, a.name
        FROM applications a
        JOIN employee_applications ea
          ON ea.application_id = a.id
        JOIN employees e
          ON e.id = ea.employee_id
        ${where}
        ORDER BY a.name
      `;

      const result = await conn.execute(query, finalBinds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      res.json(result.rows || []);
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
// Employee scoped
router.get(
  "/applications/employee",
  authMiddleware(["employee"]),
  async (req, res) => {
    return safeRoute(req, res, async (conn) => {
      // 1️⃣ Fetch applications assigned to this employee
      const result = await conn.execute(
        `
        SELECT application_name
        FROM employees
        WHERE id = :employeeId
        `,
        { employeeId: req.user.id },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      // 2️⃣ Extract & normalize unique apps
      const apps = extractUniqueApps(
        result.rows || [],
        "APPLICATION_NAME"
      );

      return res.json(apps);
    });
  }
);
//admin scoped
router.get(
  "/applications/tl",
  authMiddleware(["admin"]),
  async (req, res) => {
    return safeRoute(req, res, async (conn) => {
      // 1️⃣ Fetch applications assigned to this employee
      const result = await conn.execute(
        `
        SELECT application_name
        FROM employees
        WHERE id = :employeeId
        `,
        { employeeId: req.user.id },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      // 2️⃣ Extract & normalize unique apps
      const apps = extractUniqueApps(
        result.rows || [],
        "APPLICATION_NAME"
      );

      return res.json(apps);
    });
  }
);

// Hierarchy endpoint (for selects)
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
