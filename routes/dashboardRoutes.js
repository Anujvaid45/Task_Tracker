const express = require('express');
const oracledb = require('oracledb');
const router = express.Router();
const authMiddleware = require('../middleware/auth.js');
const { getMonthFilterOracle,getMonthFilter } = require("../utils/dateFilter"); // We'll discuss this below
const { buildVisibilityOracle } = require("../utils/visibilityOracle");
const { ROLE } = require("../utils/roles");
const { safeRoute } = require("../utils/dbWrapper");

// ------------------ ATTENDANCE SUMMARY ------------------
router.get("/attendance", authMiddleware(["admin", "manager"]), async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection();

    const managerId = req.user.role === "manager" ? req.user.id : req.user.managerId;

    const result = await connection.execute(
      `SELECT e.employee_id,
              e.name AS employee_name,
              COUNT(a.present) AS total_days,
              SUM(CASE WHEN a.present = 1 THEN 1 ELSE 0 END) AS present_days,
              ROUND(
                CASE WHEN COUNT(a.present) = 0 THEN 0
                     ELSE SUM(CASE WHEN a.present = 1 THEN 1 ELSE 0 END)/COUNT(a.present)*100
                END, 2
              ) AS percentage
       FROM attendance a
       JOIN employees e ON a.employee_id = e.employee_id
       WHERE e.manager_id = :managerId
       GROUP BY e.employee_id, e.name
       ORDER BY e.name`,
      { managerId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Error in /attendance:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// ------------------ TASKS PROGRESS ------------------
router.get(
  "/tasks-progress",
  authMiddleware(["admin", "manager", "alt","lt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {
   
      const { month, year } = req.query;
      if (!month || !year)
        return res.status(400).json({ error: "month and year are required" });

      const { startDate, endDate } = getMonthFilterOracle(month, year);


      // 🔹 Hierarchy filter
      const { sqlCondition, binds } = buildVisibilityOracle(req.user, req.query);
      binds.startDate = startDate;
      binds.endDate = endDate;

      // 🔹 Include only: due_date OR worklog entries in that month
      const sql = `
        SELECT 
          t.e_id,
          t.status,
          COUNT(DISTINCT t.task_id) AS count
        FROM tasks t
        JOIN employees e ON t.e_id = e.id
        WHERE (
          t.due_date BETWEEN :startDate AND :endDate
          OR EXISTS (
            SELECT 1
            FROM component_worklogs cw
            JOIN task_components tc ON cw.task_component_id = tc.task_component_id
            WHERE tc.task_id = t.task_id
              AND cw.log_date BETWEEN :startDate AND :endDate
          )
        )
        ${sqlCondition}
        GROUP BY t.e_id, t.status
      `;

      const result = await connection.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      // 🔹 Transform results
      const statsMap = {};
      result.rows.forEach((r) => {
        const eId = r.E_ID;
        if (!statsMap[eId]) statsMap[eId] = { id: eId, statuses: [] };
        statsMap[eId].statuses.push({
          status: r.STATUS,
          count: Number(r.COUNT),
        });
      });

      // 🔹 Get employee names
      const ids = Object.keys(statsMap);
      if (ids.length === 0) return res.json([]);

      const nameSQL = `
        SELECT id, name 
        FROM employees 
        WHERE id IN (${ids.map((_, i) => `:id${i}`).join(",")})
      `;
      const nameBinds = ids.reduce(
        (acc, val, idx) => ({ ...acc, [`id${idx}`]: val }),
        {}
      );

      const names = await connection.execute(nameSQL, nameBinds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      // 🔹 Combine & sort
      const final = names.rows
        .map((r) => ({
          id: r.ID,
          name: r.NAME,
          statuses: statsMap[r.ID]?.statuses || [],
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
        console.log("final",final)
      res.json(final);
    });
  }
);


// ------------------ WORKLOAD ROUTE ------------------
router.get("/workload", authMiddleware(["admin", "manager","alt", "lt", "head_lt"]), async (req, res) => {
  return safeRoute(req, res, async (connection) => {
    const { month, year } = req.query;

    if (!month || !year)
      return res.status(400).json({ error: "month and year are required" });

    // 🔹 Centralized visibility & application filter
    const { sqlCondition, binds } = buildVisibilityOracle(req.user, req.query);

    // 🔹 Date filter
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);
    binds.startDate = startDate;
    binds.endDate = endDate;
    binds.today = new Date();

    // --------------------------------------------------------------------------------
    // STEP 1️⃣ - Base workload query (tasks due this month OR worked this month)
    // --------------------------------------------------------------------------------
    const workloadQuery = `
      SELECT 
        t.task_id,
        t.e_id,
        t.module_id,
        t.project_id,
        NVL(t.workload_hours, 0) AS total_hours,
        SUM(
          CASE 
            WHEN t.status NOT IN ('Live','Dropped','Completed') 
                 AND t.due_date < :today 
            THEN NVL(t.workload_hours, 0) 
            ELSE 0 
          END
        ) AS overdue_hours
      FROM tasks t
      JOIN employees e ON t.e_id = e.id
      WHERE (
        t.due_date BETWEEN :startDate AND :endDate
        OR EXISTS (
          SELECT 1 
          FROM component_worklogs cw
          JOIN task_components tc 
            ON cw.task_component_id = tc.task_component_id
          WHERE tc.task_id = t.task_id
            AND cw.log_date BETWEEN :startDate AND :endDate
        )
      )
      ${sqlCondition}
      GROUP BY t.task_id, t.e_id, t.module_id, t.project_id, t.workload_hours
    `;

    const baseResult = await connection.execute(workloadQuery, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    console.log("baseresule",baseResult.rows)
    if (!baseResult.rows.length) return res.json([]);

    const taskIds = baseResult.rows.map(r => r.TASK_ID);

    // --------------------------------------------------------------------------------
    // STEP 2️⃣ - Fetch logged hours (actual work done this month)
    // 🔸 FIX: Include cw.employee_id so logs are counted per-employee
    // --------------------------------------------------------------------------------
    const logQuery = `
      SELECT 
  tc.task_id,
  cw.employee_id,

  -- 🔵 Monthly logged hours
  SUM(
    CASE 
      WHEN cw.log_date BETWEEN :startDate AND :endDate
      THEN NVL(cw.hours_logged, 0)
      ELSE 0
    END
  ) AS MONTH_LOGGED_HOURS,

  -- 🟢 Lifetime logged hours
  SUM(NVL(cw.hours_logged, 0)) AS TOTAL_LOGGED_HOURS

FROM component_worklogs cw
JOIN task_components tc 
  ON cw.task_component_id = tc.task_component_id
WHERE tc.task_id IN (${taskIds.map((_, i) => `:tid${i}`).join(",")})
GROUP BY tc.task_id, cw.employee_id

    `;

    const logBinds = {
      startDate,
      endDate,
      ...taskIds.reduce((acc, id, i) => ({ ...acc, [`tid${i}`]: id }), {}),
    };

    const logResult = await connection.execute(logQuery, logBinds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });

    // Map key = `${task_id}_${employee_id}` → logged_hours
    const logMap = Object.fromEntries(
  logResult.rows.map(r => [
    `${r.TASK_ID}_${r.EMPLOYEE_ID}`,
    {
      month: r.MONTH_LOGGED_HOURS || 0,
      total: r.TOTAL_LOGGED_HOURS || 0,
    }
  ])
);

    // --------------------------------------------------------------------------------
    // STEP 3️⃣ - Combine base + logged data
    // --------------------------------------------------------------------------------
   const combined = baseResult.rows.map(row => {
  const logs = logMap[`${row.TASK_ID}_${row.E_ID}`] || { month: 0, total: 0 };

  const total = row.TOTAL_HOURS || 0;
  const completed = Math.min(logs.total, total);
  const pending = Math.max(total - completed, 0);

  return {
    e_id: row.E_ID,
    module_id: row.MODULE_ID,
    project_id: row.PROJECT_ID,

    total_hours: total,
    completed_hours: completed,          // 🟢 cumulative
    pending_hours: pending,
    overdue_hours: row.OVERDUE_HOURS || 0,

    month_logged_hours: logs.month        // 🔵 optional (for UI)
  };
});


    // --------------------------------------------------------------------------------
// STEP 4️⃣ - Aggregate per employee + module + project (sum all relevant hours)
// --------------------------------------------------------------------------------
const aggregated = Object.values(
  combined.reduce((acc, row) => {
    const key = `${row.e_id}-${row.module_id}-${row.project_id}`;

    if (!acc[key]) {
      acc[key] = { ...row, task_count: 1 };
    } else {
      acc[key].task_count++;
      acc[key].total_hours += row.total_hours || 0;
      acc[key].completed_hours += row.completed_hours || 0;
      acc[key].pending_hours += row.pending_hours || 0;
      acc[key].overdue_hours += row.overdue_hours || 0;
    }

    return acc;
  }, {})
);


    // --------------------------------------------------------------------------------
    // STEP 5️⃣ - Fetch details for employees, modules, and projects
    // --------------------------------------------------------------------------------
    const uniqueEmployeeIds = [...new Set(aggregated.map(r => r.e_id))];
    const uniqueModuleIds = [...new Set(aggregated.map(r => r.module_id).filter(Boolean))];
    const uniqueProjectIds = [...new Set(aggregated.map(r => r.project_id).filter(Boolean))];

    const employees =
      uniqueEmployeeIds.length > 0
        ? await connection.execute(
            `SELECT id, name, skills FROM employees 
             WHERE id IN (${uniqueEmployeeIds.map((_, i) => `:id${i}`).join(",")})`,
            uniqueEmployeeIds.reduce((acc, val, idx) => ({ ...acc, [`id${idx}`]: val }), {}),
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
          )
        : { rows: [] };

    const modules =
      uniqueModuleIds.length > 0
        ? await connection.execute(
            `SELECT id, name AS module_name FROM modules 
             WHERE id IN (${uniqueModuleIds.map((_, i) => `:id${i}`).join(",")})`,
            uniqueModuleIds.reduce((acc, val, idx) => ({ ...acc, [`id${idx}`]: val }), {}),
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
          )
        : { rows: [] };

    const projects =
      uniqueProjectIds.length > 0
        ? await connection.execute(
            `SELECT id, name AS project_name FROM projects 
             WHERE id IN (${uniqueProjectIds.map((_, i) => `:id${i}`).join(",")})`,
            uniqueProjectIds.reduce((acc, val, idx) => ({ ...acc, [`id${idx}`]: val }), {}),
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
          )
        : { rows: [] };

    // --------------------------------------------------------------------------------
    // STEP 6️⃣ - Merge into enriched final response
    // --------------------------------------------------------------------------------
    const enrichedWorkloads = aggregated.map(row => {
      const employee = employees.rows.find(e => e.ID === row.e_id) || {};
      const module = modules.rows.find(m => m.ID === row.module_id) || {};
      const project = projects.rows.find(p => p.ID === row.project_id) || {};

      const total = row.total_hours || 0;
      const pct = val => (total > 0 ? Math.round((val / total) * 100) : 0);

      return {
        employeeId: row.e_id,
        employeeName: employee.NAME || "Unknown Employee",
        skills: employee.SKILLS ? employee.SKILLS.split(",") : [],
        moduleName: module.MODULE_NAME || "N/A",
        projectName: project.PROJECT_NAME || "N/A",
        taskCount: row.task_count,
        summary: {
          totalHours: total,
          completedHours: row.completed_hours,
          pendingHours: row.pending_hours,
          overdueHours: row.overdue_hours,
          percentages: {
            completed: pct(row.completed_hours),
            pending: pct(row.pending_hours),
            overdue: pct(row.overdue_hours),
          },
        },
      };
    });

    res.json(enrichedWorkloads);
  });

});



// ------------------ MODULE SUMMARY ROUTE ------------------
router.get(
  "/module-summary",
  authMiddleware(["admin", "manager", "alt", "lt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {

      const today = new Date();

      // 🔹 Centralized role + application filter
      const { sqlCondition, binds } = buildVisibilityOracle(req.user, req.query);
      binds.today = today;

      // ------------------------------------------------------------
      // STEP 1️⃣ - Core Query (DATE-INDEPENDENT)
      // ------------------------------------------------------------
      const sql = `
        SELECT
          m.id AS "id",
          m.name AS "moduleName",
          COUNT(DISTINCT p.id) AS "projectCount",
          COUNT(DISTINCT t.task_id) AS "taskCount",

          -- Completed Tasks
          SUM(CASE 
                WHEN t.status IN ('Live','Preprod_Signoff','Completed') 
                THEN 1 ELSE 0 
              END) AS "completedTasks",

          -- In Progress Tasks
          SUM(CASE 
                WHEN t.status IN ('Under_Development','Under_UAT','WIP','Under_Preprod','UAT_Signoff','Under_QA') 
                THEN 1 ELSE 0 
              END) AS "inProgressTasks",

          -- Pending Tasks
          SUM(CASE 
                WHEN t.status IN ('BRS_Discussion','Approach_Preparation','Pending','Approach_Finalization') 
                THEN 1 ELSE 0 
              END) AS "pendingTasks",

          -- Overdue In Progress
          SUM(CASE 
                WHEN t.status IN ('Under_Development','Under_UAT','Under_Preprod','UAT_Signoff','Under_QA','WIP') 
                     AND t.due_date < :today 
                THEN 1 ELSE 0 
              END) AS "overdueInProgress",

          -- Overdue Pending
          SUM(CASE 
                WHEN t.status IN ('BRS_Discussion','Approach_Preparation','Approach_Finalization','Pending') 
                     AND t.due_date < :today 
                THEN 1 ELSE 0 
              END) AS "overduePending",

          -- Distinct Employees
          COUNT(DISTINCT t.e_id) AS "employeeCount"

        FROM modules m
        LEFT JOIN projects p ON p.module_id = m.id
        LEFT JOIN tasks t ON t.project_id = p.id
        LEFT JOIN employees e ON t.e_id = e.id

        WHERE t.e_id IS NOT NULL
        ${sqlCondition}

        GROUP BY m.id, m.name
        ORDER BY m.name
      `;

      const modulesRes = await connection.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      // ------------------------------------------------------------
      // STEP 2️⃣ - Response
      // ------------------------------------------------------------
      res.json({
        modules: modulesRes.rows || [],
        selectedApplication: req.query.applicationName || "all",
      });
    });
  }
);


// ---------------------- Project Summary ----------------------
router.get(
  "/project-summary",
  authMiddleware(["admin", "manager", "alt", "lt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {
      const { tlId } = req.query;

      // 🔹 Centralized visibility & app filter
      const { sqlCondition, binds } = buildVisibilityOracle(req.user, req.query);

      const today = new Date();
      binds.today = today;

      // ✅ If TL filter applied, use tech_fpr_tl instead of employee visibility
      let projectFilterSQL = sqlCondition;
      if (tlId) {
        projectFilterSQL += ` AND p.tech_fpr_tl = :tlId`;
        binds.tlId = tlId;
      }

      // --------------------------------------------------
      // STEP 1️⃣ - Project summary (DATE-INDEPENDENT)
      // --------------------------------------------------
      const summarySQL = `
        SELECT
          p.id AS "projectId",
          p.name AS "projectName",
          p.PLANNED_END_DATE AS "plannedEndDate",
          p.ON_TRACK_STATUS AS "onTrackStatus",
          p.GO_LIVE_END_DATE AS "goLiveEndDate",
          m.name AS "moduleName",
          p.project_stage AS "projectStage",
          COUNT(DISTINCT t.task_id) AS "taskCount",
          COUNT(DISTINCT t.e_id) AS "employeeCount",

          -- Completed
          SUM(CASE 
                WHEN t.status IN ('Live','Preprod_Signoff','Completed') 
                THEN 1 ELSE 0 
              END) AS "completedTasks",

          -- In Progress
          SUM(CASE 
                WHEN t.status IN ('Under_Development','Under_UAT','Under_Preprod','UAT_Signoff','Under_QA','WIP') 
                THEN 1 ELSE 0 
              END) AS "inProgressTasks",

          -- Pending
          SUM(CASE 
                WHEN t.status IN ('BRS_Discussion','Approach_Preparation','Approach_Finalization','Pending') 
                THEN 1 ELSE 0 
              END) AS "pendingTasks",

          -- Overdue In Progress
          SUM(CASE 
                WHEN t.status IN ('Under_Development','Under_UAT','Under_Preprod','UAT_Signoff','Under_QA','WIP') 
                     AND t.due_date < :today 
                THEN 1 ELSE 0 
              END) AS "overdueInProgress",

          -- Overdue Pending
          SUM(CASE 
                WHEN t.status IN ('BRS_Discussion','Approach_Preparation','Approach_Finalization','Pending') 
                     AND t.due_date < :today 
                THEN 1 ELSE 0 
              END) AS "overduePending"

        FROM projects p
        LEFT JOIN modules m ON p.module_id = m.id
        LEFT JOIN tasks t ON t.project_id = p.id
        LEFT JOIN employees e ON t.e_id = e.id
        WHERE t.e_id IS NOT NULL
        ${projectFilterSQL}
        GROUP BY p.id, p.name, m.name, p.project_stage, p.planned_end_date, p.on_track_status,p.go_live_end_date
        ORDER BY p.name
      `;

      const summaryResult = await connection.execute(summarySQL, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      const projects = summaryResult.rows || [];
      console.log(projects)
      if (projects.length === 0) {
        return res.json({
          projects: [],
          selectedApplication: req.query.applicationName || "all",
        });
      }

      // --------------------------------------------------
      // STEP 2️⃣ - Fetch project change logs (CLOB parsing)
      // --------------------------------------------------
      const projectIds = projects.map((p) => p.projectId);
      const clobSQL = `
        SELECT 
          p.id AS "projectId",
          p.updated_at AS "updatedAt",
          p.change_log AS "changeLog"
        FROM projects p
        WHERE p.id IN (${projectIds.map((_, i) => `:id${i}`).join(",")})
      `;

      const clobBinds = projectIds.reduce(
        (acc, id, i) => ({ ...acc, [`id${i}`]: id }),
        {}
      );

      const clobResult = await connection.execute(clobSQL, clobBinds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      const changeLogs = [];
      for (const row of clobResult.rows) {
        let existingLog = [];
        try {
          if (row.changeLog) {
            let logData;
            if (row.changeLog instanceof oracledb.Lob) {
              logData = await new Promise((resolve, reject) => {
                let data = "";
                row.changeLog.setEncoding("utf8");
                row.changeLog.on("data", (chunk) => (data += chunk));
                row.changeLog.on("end", () => resolve(data));
                row.changeLog.on("error", (err) => reject(err));
              });
            } else {
              logData = row.changeLog;
            }
            const parsed = JSON.parse(logData);
            existingLog = Array.isArray(parsed) ? parsed : [parsed];
          }
        } catch (err) {
          console.error(
            `Failed to parse change_log for project ${row.projectId}:`,
            err
          );
          existingLog = [];
        }

        changeLogs.push({
          projectId: row.projectId,
          updatedAt: row.updatedAt,
          changeLog: existingLog,
        });
      }

      // --------------------------------------------------
      // STEP 3️⃣ - Extract project stage transitions
      // --------------------------------------------------
      const stageChangesMap = {};
      changeLogs.forEach((logEntry) => {
        const entries = logEntry.changeLog || [];
        stageChangesMap[logEntry.projectId] = entries
          .filter((e) => e.changes && e.changes.project_stage)
          .map((e) => ({
            stage: e.changes.project_stage.new,
            changedAt: formatDateForDisplay(e.timestamp),
          }));
      });

      // --------------------------------------------------
      // STEP 4️⃣ - Attach stage changes to summary
      // --------------------------------------------------
      const projectsWithStages = projects.map((p) => ({
        ...p,
        stageChanges: stageChangesMap[p.projectId] || [],
      }));

      // --------------------------------------------------
      // STEP 5️⃣ - Final response
      // --------------------------------------------------
      res.json({
        projects: projectsWithStages,
        selectedApplication: req.query.applicationName || "all",
      });
    });
  }
);



router.get(
  "/project-stage-summary",
  authMiddleware(["admin", "manager","alt", "lt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {
      const { tlId, applicationName } = req.query;


      // ✅ Manual binds (no employee joins here)
      const binds = {};

      // ✅ Filter logic at project level
      let projectFilterSQL = "";

      if (tlId) {
        projectFilterSQL += ` AND p.tech_fpr_tl = :tlId`;
        binds.tlId = tlId;
      }

      if (applicationName && applicationName.trim() !== "") {
        projectFilterSQL += ` AND LOWER(p.application_name) = LOWER(:appName)`;
        binds.appName = applicationName.trim();
      }

      // --------------------------------------------------
      // STEP 1️⃣ - Stage-wise project count summary
      // --------------------------------------------------
      const summarySQL = `
        SELECT
          p.project_stage AS "projectStage",
          COUNT(p.id) AS "count"
        FROM projects p
        LEFT JOIN modules m ON p.module_id = m.id
        WHERE 1=1
          ${projectFilterSQL}
        GROUP BY p.project_stage
        ORDER BY p.project_stage
      `;

      const result = await connection.execute(summarySQL, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      // --------------------------------------------------
      // STEP 2️⃣ - Format stage-wise output
      // --------------------------------------------------
      const allStages = [
        "BRS_Discussion",
        "Approach_Preparation",
        "Approach_Finalization",
        "Under_Development",
        "Under_QA",
        "Under_UAT",
        "Under_Preprod",
        "Preprod_Signoff",
        "Live",
        "Hold",
        "Dropped",
      ];

      const stageCounts = {};
      allStages.forEach((stage) => {
        const record = result.rows.find((r) => r.projectStage === stage);
        stageCounts[stage] = record ? Number(record.count) : 0;
      });

      res.json({
        stageCounts,
        selectedTL: tlId || "all",
        selectedApplication: applicationName || "all",
      });
    
  });
});




// ---------------------- Employee Distribution ----------------------
router.get(
  "/employee-distribution",
  authMiddleware(["admin", "manager","alt", "lt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {
      const { month, year } = req.query;
      if (!month || !year)
        return res.status(400).json({ error: "month and year are required" });

      // 🔹 Centralized role + application filter
      const { sqlCondition, binds } = buildVisibilityOracle(req.user, req.query);

      // 🔹 Date range (for both due date and worklogs)
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0, 23, 59, 59);
      binds.startDate = startDate;
      binds.endDate = endDate;

      // ------------------------------------------------------------
      // STEP 1️⃣ - Get tasks due OR worked this month (filtered)
      // ------------------------------------------------------------
      const sql = `
        SELECT 
          m.id AS "moduleId",
          m.name AS "moduleName",
          e.id AS "employeeId",
          e.name AS "employeeName",
          COUNT(DISTINCT t.task_id) AS "taskCount"
        FROM tasks t
        JOIN projects p ON t.project_id = p.id
        JOIN modules m ON p.module_id = m.id
        JOIN employees e ON t.e_id = e.id
        WHERE t.e_id IS NOT NULL
          AND (
            t.due_date BETWEEN :startDate AND :endDate
            OR EXISTS (
              SELECT 1 
              FROM component_worklogs cw
              JOIN task_components tc 
                ON cw.task_component_id = tc.task_component_id
              WHERE tc.task_id = t.task_id
                AND cw.log_date BETWEEN :startDate AND :endDate
            )
          )
          ${sqlCondition}
        GROUP BY m.id, m.name, e.id, e.name
        ORDER BY m.name, e.name
      `;

      const result = await connection.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      // ------------------------------------------------------------
      // STEP 2️⃣ - Aggregate data per module
      // ------------------------------------------------------------
      const distribution = {};
      result.rows.forEach((row) => {
        if (!distribution[row.moduleId]) {
          distribution[row.moduleId] = {
            moduleName: row.moduleName,
            employees: [],
            totalTasks: 0,
          };
        }

        distribution[row.moduleId].employees.push({
          id: row.employeeId,
          name: row.employeeName,
          taskCount: row.taskCount,
        });

        distribution[row.moduleId].totalTasks += row.taskCount;
      });

      // ------------------------------------------------------------
      // STEP 3️⃣ - Response
      // ------------------------------------------------------------
      const response = Object.values(distribution);

      console.log(
        "📊 Employee Distribution:\n",
        JSON.stringify(response, null, 2)
      );

      res.json(response);
    }); 
  }
);

// Helper: format for UI
function formatDateForDisplay(date) 
{
 if (!date) return null; 
const d = new Date(date); 
const day = String(d.getDate()).padStart(2, "0"); 
const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]; 
const month = monthNames[d.getMonth()]; const year = d.getFullYear(); 
return `${day}-${month}-${year}`; 
}

// ---------------------- Overdue Tasks ----------------------
router.get("/overdue", authMiddleware(["admin", "manager","alt", "lt", "head_lt"]), async (req, res) => {
  return safeRoute(req, res, async (connection) => {
    const { month, year } = req.query;

    // 🔹 Centralized role + application filter
    const { sqlCondition, binds } = buildVisibilityOracle(req.user, req.query);

    // 🔹 Optional month/year filter
    let monthFilter = "";
    if (month && year) {
      monthFilter = "EXTRACT(MONTH FROM t.due_date) = :month AND EXTRACT(YEAR FROM t.due_date) = :year";
      binds.month = month;
      binds.year = year;
    }

    // --------------------------------------------
    // 🔹 Query overdue tasks (bind-safe + filtered)
    // --------------------------------------------
    const sql = `
      SELECT 
        t.task_id AS "taskId",
        t.title AS "title",
        t.status AS "status",
        t.priority AS "priority",
        t.due_date AS "dueDate",
        t.completed_at AS "completedAt",
        t.created_at AS "createdAt",
        t.updated_at AS "updatedAt",
        e.id AS "employeeId",
        e.name AS "employeeName"
      FROM tasks t
      JOIN employees e ON t.e_id = e.id
      WHERE 
        t.due_date < TRUNC(SYSDATE)
        AND t.status NOT IN ('Live','Preprod_Signoff','Completed')
        ${sqlCondition}
        ${monthFilter ? `AND ${monthFilter}` : ""}
      ORDER BY t.due_date ASC
    `;

    const result = await connection.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

    // --------------------------------------------
    // 🔹 Format for frontend (same shape as before)
    // --------------------------------------------
    const overdue = result.rows.map(row => ({
      taskId: row.taskId,
      title: row.title,
      status: row.status,
      priority: row.priority,
      employeeId: { id: row.employeeId, name: row.employeeName },
      dueDateRaw: row.dueDate,
      createdAtRaw: row.createdAt,
      updatedAtRaw: row.updatedAt,
      completedAtRaw: row.completedAt,
      dueDate: formatDateForDisplay(row.dueDate),
      createdAt: formatDateForDisplay(row.createdAt),
      updatedAt: formatDateForDisplay(row.updatedAt),
      completedAt: formatDateForDisplay(row.completedAt),
    }));

    res.json(overdue);
  } );
});

// ---------------------- Delayed Tasks ----------------------
router.get(
  "/delayed",
  authMiddleware(["admin", "manager", "alt", "lt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {
      const { month, year } = req.query;

      // 🔹 Centralized role + application filter
      const { sqlCondition, binds } = buildVisibilityOracle(req.user, req.query);

      // 🔹 Optional month/year filter (based on due date)
      let monthFilter = "";
      if (month && year) {
        monthFilter = `
          EXTRACT(MONTH FROM t.due_date) = :month
          AND EXTRACT(YEAR FROM t.due_date) = :year
        `;
        binds.month = month;
        binds.year = year;
      }

      // ---------------------------------------------
      // 🔹 SQL Query (FIXED DATE COMPARISON)
      // ---------------------------------------------
      const sql = `
        SELECT 
          t.task_id AS "taskId",
          t.title AS "title",
          t.status AS "status",
          t.due_date AS "dueDate",
          t.completed_at AS "completedAt",
          t.created_at AS "createdAt",
          t.updated_at AS "updatedAt",
          e.id AS "employeeId",
          e.name AS "employeeName"
        FROM tasks t
        JOIN employees e ON t.e_id = e.id
        WHERE 
          TRUNC(t.completed_at) > TRUNC(t.due_date)
          AND t.status IN ('Live','Preprod_Signoff','Completed')
          ${sqlCondition}
          ${monthFilter ? `AND ${monthFilter}` : ""}
        ORDER BY t.completed_at ASC
      `;

      const result = await connection.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      // ---------------------------------------------
      // 🔹 Format response
      // ---------------------------------------------
      const delayed = result.rows.map(row => ({
        taskId: row.taskId,
        title: row.title,
        status: row.status,
        employeeId: { id: row.employeeId, name: row.employeeName },
        dueDateRaw: row.dueDate,
        createdAtRaw: row.createdAt,
        updatedAtRaw: row.updatedAt,
        completedAtRaw: row.completedAt,
        dueDate: formatDateForDisplay(row.dueDate),
        createdAt: formatDateForDisplay(row.createdAt),
        updatedAt: formatDateForDisplay(row.updatedAt),
        completedAt: formatDateForDisplay(row.completedAt),
      }));

      res.json(delayed);
    });
  }
);


// ---------------------- Tasks Progress Weekly ----------------------
router.get(
  "/tasks-progress-weekly",
  authMiddleware(["admin", "manager", "lt","alt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {
      const { month, year } = req.query;
      if (!month || !year)
        return res.status(400).json({ error: "month and year are required" });


      // 🔹 Hierarchy + visibility filter
      const { sqlCondition, binds } = buildVisibilityOracle(req.user, req.query);

      // 🔹 Date filter for the selected month
      const startDate = new Date(Number(year), Number(month) - 1, 1);
      const endDate = new Date(Number(year), Number(month), 0, 23, 59, 59);
      binds.startDate = startDate;
      binds.endDate = endDate;

      // --------------------------------------------------------------------------------
      // STEP 1️⃣ - Get tasks due OR worked in this month
      // --------------------------------------------------------------------------------
      const taskQuery = `
        SELECT 
          t.task_id,
          t.title,
          t.status,
          t.due_date,
          t.completed_at,
          e.id AS employee_id,
          e.name AS employee_name,
          NVL(t.workload_hours, 0) AS workload_hours
        FROM tasks t
        JOIN employees e ON t.e_id = e.id
        WHERE (
          t.due_date BETWEEN :startDate AND :endDate
          OR EXISTS (
            SELECT 1 FROM component_worklogs cw
            JOIN task_components tc ON cw.task_component_id = tc.task_component_id
            WHERE tc.task_id = t.task_id
              AND cw.log_date BETWEEN :startDate AND :endDate
          )
        )
        ${sqlCondition}
        ORDER BY t.due_date ASC
      `;

      const taskResult = await connection.execute(taskQuery, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      const tasks = taskResult.rows || [];
      if (!tasks.length)
        return res.json({
          weekly: [],
          dueThisWeek: [],
          weeklyStats: {},
          monthlyOverview: {},
        });

      // --------------------------------------------------------------------------------
      // STEP 2️⃣ - Get total logged hours for each task (for partial tracking)
      // --------------------------------------------------------------------------------
      const taskIds = tasks.map((t) => t.TASK_ID);
      let logMap = {};

      if (taskIds.length > 0) {
        const logQuery = `
          SELECT 
            tc.task_id,
            SUM(NVL(cw.hours_logged, 0)) AS logged_hours
          FROM component_worklogs cw
          JOIN task_components tc ON cw.task_component_id = tc.task_component_id
          WHERE cw.log_date BETWEEN :startDate AND :endDate
            AND tc.task_id IN (${taskIds.map((_, i) => `:tid${i}`).join(",")})
          GROUP BY tc.task_id
        `;

        const logBinds = {
          startDate,
          endDate,
          ...taskIds.reduce((acc, id, i) => ({ ...acc, [`tid${i}`]: id }), {}),
        };

        const logResult = await connection.execute(logQuery, logBinds, {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });

        logMap = Object.fromEntries(
          logResult.rows.map((r) => [r.TASK_ID, r.LOGGED_HOURS || 0])
        );
      }

      // --------------------------------------------------------------------------------
      // STEP 3️⃣ - Categorization setup
      // --------------------------------------------------------------------------------
      const completedStatuses = ["Live", "Preprod_Signoff", "Completed"];
      const inProgressStatuses = [
        "Under_Development",
        "Under_UAT",
        "Under_Preprod",
        "UAT_Signoff",
        "Under_QA",
        "WIP",
      ];
      const pendingStatuses = [
        "BRS_Discussion",
        "Approach_Preparation",
        "Approach_Finalization",
        "Pending",
      ];

      const getWeekNumberInMonth = (date) => Math.ceil(new Date(date).getDate() / 7);

      const employeeWeekly = {};
      const dueThisWeekTasks = [];
      const weeklyStats = { 1: {}, 2: {}, 3: {}, 4: {}, 5: {} };
      Object.keys(weeklyStats).forEach(
        (k) =>
          (weeklyStats[k] = {
            completed: 0,
            inProgress: 0,
            pending: 0,
            overdue: 0,
          })
      );

      const today = new Date();
      const currentWeek =
        today.getFullYear() == year && today.getMonth() + 1 == Number(month)
          ? getWeekNumberInMonth(today)
          : 0;

      const todayDateOnly = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate()
      );

      // Helper to safely parse Oracle dates
      const parseOracleDate = (val) => {
        if (!val) return null;
        const d = val instanceof Date ? val : new Date(val);
        return isNaN(d.getTime()) ? null : d;
      };

      // --------------------------------------------------------------------------------
      // STEP 4️⃣ - Process tasks
      // --------------------------------------------------------------------------------
      for (const task of tasks) {
        const empId = task.EMPLOYEE_ID?.toString() || "unknown";
        const empName = task.EMPLOYEE_NAME || "Unknown";

        if (!employeeWeekly[empId]) {
          employeeWeekly[empId] = {
            employeeId: empId,
            name: empName,
            weekly: { 1: {}, 2: {}, 3: {}, 4: {}, 5: {} },
          };
          Object.keys(employeeWeekly[empId].weekly).forEach(
            (k) =>
              (employeeWeekly[empId].weekly[k] = {
                completed: 0,
                inProgress: 0,
                pending: 0,
                overdue: 0,
              })
          );
        }

        const dueDate = parseOracleDate(task.DUE_DATE);
        const completedAt = parseOracleDate(task.COMPLETED_AT);
        if (!dueDate) continue;

        const dueWeek = getWeekNumberInMonth(dueDate);
        const loggedHours = logMap[task.TASK_ID] || 0;
        const totalHours = task.WORKLOAD_HOURS || 0;
        const isOverdue = dueDate < todayDateOnly;

        // 🔹 Categorization logic
        if (completedStatuses.includes(task.STATUS)) {
  const week = completedAt ? getWeekNumberInMonth(completedAt) : dueWeek;
  employeeWeekly[empId].weekly[week].completed++;
  weeklyStats[week].completed++;
}

else if (inProgressStatuses.includes(task.STATUS)) {
  // ✅ Fix: preserve overdue logic here too
  if (isOverdue) {
    employeeWeekly[empId].weekly[dueWeek].overdue++;
    weeklyStats[dueWeek].overdue++;
  } else {
    employeeWeekly[empId].weekly[dueWeek].inProgress++;
    weeklyStats[dueWeek].inProgress++;
  }
}

else if (pendingStatuses.includes(task.STATUS)) {
  if (isOverdue) {
    employeeWeekly[empId].weekly[dueWeek].overdue++;
    weeklyStats[dueWeek].overdue++;
  } else {
    employeeWeekly[empId].weekly[dueWeek].pending++;
    weeklyStats[dueWeek].pending++;
  }
}


        if (dueWeek === currentWeek) {
          dueThisWeekTasks.push({
            taskId: task.TASK_ID,
            title: task.TITLE,
            employee: empName,
            dueDate: formatDateForDisplay(task.DUE_DATE),
            status: task.STATUS,
            isOverdue,
          });
        }
      }

      // --------------------------------------------------------------------------------
      // STEP 5️⃣ - Monthly summary
      // --------------------------------------------------------------------------------
      const monthlyOverview = {
        completed: 0,
        inProgress: 0,
        pending: 0,
        overdue: 0,
        total: 0,
      };

      Object.values(weeklyStats).forEach((w) => {
        monthlyOverview.completed += w.completed;
        monthlyOverview.inProgress += w.inProgress;
        monthlyOverview.pending += w.pending;
        monthlyOverview.overdue += w.overdue;
      });

      monthlyOverview.total =
        monthlyOverview.completed +
        monthlyOverview.inProgress +
        monthlyOverview.pending +
        monthlyOverview.overdue;

      monthlyOverview.completionRate =
        monthlyOverview.total > 0
          ? Math.round((monthlyOverview.completed / monthlyOverview.total) * 100)
          : 0;

      // --------------------------------------------------------------------------------
      // STEP 6️⃣ - Send Response
      // --------------------------------------------------------------------------------
      const responsePayload = {
        weekly: Object.values(employeeWeekly),
        dueThisWeek: dueThisWeekTasks,
        weeklyStats,
        monthlyOverview,
        currentWeek,
        selectedMonth: {
          month: Number(month),
          year: Number(year),
          monthName: new Date(year, month - 1).toLocaleString("default", {
            month: "long",
          }),
        },
      };
      res.json(responsePayload);
    });
  }
);

module.exports = router;
