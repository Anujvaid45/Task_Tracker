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
  authMiddleware(["admin", "manager", "alt", "lt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {
      const { month, year } = req.query;
      if (!month || !year) {
        return res.status(400).json({ error: "month and year are required" });
      }

      const { startDate, endDate } = getMonthFilterOracle(month, year);

      // -------------------------------------------------------
      // Visibility (hierarchy only)
      // -------------------------------------------------------
      const {
        sqlCondition,
        binds: visibilityBinds,
      } = buildVisibilityOracle(req.user, req.query);

      // -------------------------------------------------------
      // MAIN QUERY
      // -------------------------------------------------------
      const sql = `
        SELECT 
          t.e_id,
          t.status,
          COUNT(DISTINCT t.task_id) AS count
        FROM tasks t
        JOIN employees e ON t.e_id = e.id
        WHERE (
          -- 🟢 Pending tasks from previous months (still open)
          (
            t.status NOT IN ('Completed', 'Dropped', 'Live')
            AND t.due_date <= :endDate
          )

          OR

          -- 🔵 Tasks due in this month
          t.due_date BETWEEN :startDate AND :endDate

          OR

          -- 🟣 Tasks with worklogs in this month
          EXISTS (
            SELECT 1
            FROM component_worklogs cw
            JOIN task_components tc
              ON cw.task_component_id = tc.task_component_id
            WHERE tc.task_id = t.task_id
              AND cw.log_date BETWEEN :startDate AND :endDate
          )
        )
        ${sqlCondition}
        GROUP BY t.e_id, t.status
      `;

      const result = await connection.execute(
        sql,
        {
          startDate,
          endDate,
          ...visibilityBinds,
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      // -------------------------------------------------------
      // TRANSFORM RESULTS
      // -------------------------------------------------------
      const statsMap = {};
      result.rows.forEach((r) => {
        const eId = r.E_ID;
        if (!statsMap[eId]) statsMap[eId] = { id: eId, statuses: [] };
        statsMap[eId].statuses.push({
          status: r.STATUS,
          count: Number(r.COUNT),
        });
      });

      const ids = Object.keys(statsMap);
      if (ids.length === 0) return res.json([]);

      // -------------------------------------------------------
      // FETCH EMPLOYEE NAMES
      // -------------------------------------------------------
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

      // -------------------------------------------------------
      // FINAL RESPONSE
      // -------------------------------------------------------
      const final = names.rows
        .map((r) => ({
          id: r.ID,
          name: r.NAME,
          statuses: statsMap[r.ID]?.statuses || [],
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      res.json(final);
    });
  }
);


// --------------------LIVE ISSUES SUMMARY--------------------
router.get(
  "/live-issues-progress",
  authMiddleware(["admin", "manager", "alt", "lt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {
      const { month, year } = req.query;

      if (!month || !year) {
        return res.status(400).json({ error: "month and year are required" });
      }

      const { startDate, endDate } = getMonthFilterOracle(month, year);

      // -------------------------------------------------------
      // Visibility (hierarchy only)
      // -------------------------------------------------------
      const {
        sqlCondition,
        binds: visibilityBinds,
      } = buildVisibilityOracle(req.user, req.query);

      // =======================================================
      // LIVE ISSUE PROGRESS QUERY (FINAL)
      // =======================================================
      const sql = `
        SELECT
          li.assigned_employee_id AS e_id,
          li.status,
          COUNT(DISTINCT li.id) AS count
        FROM live_issues li
        JOIN employees e
          ON li.assigned_employee_id = e.id
        WHERE (
          -- 🟢 Pending live issues from previous months
          (
            li.status IN ('Open','WIP','Pending')
            AND li.date_reported <= :endDate
          )

          OR

          -- 🔵 Live issues due this month
          li.uat_eta_date BETWEEN :startDate AND :endDate

          OR

          -- 🟣 Live issues worked on this month
          EXISTS (
            SELECT 1
            FROM component_worklogs cw
            JOIN live_issue_components lic
              ON cw.task_component_id = lic.live_issue_component_id
            WHERE lic.live_issue_id = li.id
              AND cw.log_date BETWEEN :startDate AND :endDate
          )

          OR

          -- 🟠 Live issues reported this month (NEW)
          li.date_reported BETWEEN :startDate AND :endDate
        )
        ${sqlCondition}
        GROUP BY li.assigned_employee_id, li.status
      `;

      const result = await connection.execute(
        sql,
        {
          startDate,
          endDate,
          ...visibilityBinds,
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      // =======================================================
      // TRANSFORM RESULT
      // =======================================================
      const statsMap = {};
      result.rows.forEach((r) => {
        const eId = r.E_ID;
        if (!statsMap[eId]) statsMap[eId] = { id: eId, statuses: [] };

        statsMap[eId].statuses.push({
          status: r.STATUS,
          count: Number(r.COUNT),
        });
      });

      // =======================================================
      // FETCH EMPLOYEE NAMES
      // =======================================================
      const ids = Object.keys(statsMap);
      if (!ids.length) return res.json([]);

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

      // =======================================================
      // FINAL RESPONSE
      // =======================================================
      const final = names.rows
        .map((r) => ({
          id: r.ID,
          name: r.NAME,
          statuses: statsMap[r.ID]?.statuses || [],
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      res.json(final);
    });
  }
);

// ------------------ WORKLOAD SUMMARY ROUTE ------------------
router.get(
  "/workload",
  authMiddleware(["admin", "manager", "alt", "lt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {
      const { month, year } = req.query;

      if (!month || !year) {
        return res.status(400).json({ error: "month and year are required" });
      }

      // -------------------------------------------------------
      // Visibility (ROLE / HIERARCHY ONLY)
      // -------------------------------------------------------
      const {
        sqlCondition,
        binds: visibilityBinds,
      } = buildVisibilityOracle(req.user, req.query);

      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0, 23, 59, 59);
      const today = new Date();

      // =======================================================
      // 1️⃣ TASK BASE QUERY (OVERALL VISIBILITY)
      // =======================================================
      const taskBaseSQL = `
        SELECT 
          t.task_id,
          t.e_id,
          t.module_id,
          t.project_id,
          NVL(t.workload_hours, 0) AS total_hours,
          SUM(
            CASE 
              WHEN t.status NOT IN ('Live','Dropped','Completed')
                   AND TRUNC(t.due_date) < TRUNC(:today)
              THEN NVL(t.workload_hours, 0)
              ELSE 0
            END
          ) AS overdue_hours
        FROM tasks t
        JOIN employees e ON t.e_id = e.id
        WHERE 1 = 1
        ${sqlCondition}
        GROUP BY
          t.task_id,
          t.e_id,
          t.module_id,
          t.project_id,
          t.workload_hours
      `;

      const taskBase = await connection.execute(
        taskBaseSQL,
        {
          today,
          ...visibilityBinds,
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      // =======================================================
      // 2️⃣ TASK LOGS (MONTHLY + LIFETIME)
      // =======================================================
      const taskIds = taskBase.rows.map(r => r.TASK_ID);
      let taskLogMap = {};

      if (taskIds.length) {
        const taskLogSQL = `
          SELECT 
            tc.task_id,
            cw.employee_id,
            SUM(
              CASE 
                WHEN cw.log_date BETWEEN :startDate AND :endDate
                THEN NVL(cw.hours_logged, 0)
                ELSE 0
              END
            ) AS MONTH_LOGGED,
            SUM(NVL(cw.hours_logged, 0)) AS TOTAL_LOGGED
          FROM component_worklogs cw
          JOIN task_components tc
            ON cw.task_component_id = tc.task_component_id
          WHERE tc.task_id IN (${taskIds.map((_, i) => `:tid${i}`).join(",")})
          GROUP BY tc.task_id, cw.employee_id
        `;

        const taskLogBinds = {
          startDate,
          endDate,
          ...taskIds.reduce((a, id, i) => ({ ...a, [`tid${i}`]: id }), {}),
        };

        const logs = await connection.execute(taskLogSQL, taskLogBinds, {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });

        taskLogMap = Object.fromEntries(
          logs.rows.map(r => [
            `${r.TASK_ID}_${r.EMPLOYEE_ID}`,
            { month: r.MONTH_LOGGED || 0, total: r.TOTAL_LOGGED || 0 },
          ])
        );
      }

      // =======================================================
      // 3️⃣ LIVE ISSUE BASE QUERY (OVERALL VISIBILITY)
      // =======================================================
      const issueBaseSQL = `
        SELECT
          li.id AS live_issue_id,
          li.assigned_employee_id AS e_id,
          NVL(li.workload_hours, 0) AS total_hours,
          SUM(
            CASE
              WHEN li.status IN ('Open','Live')
                   AND li.uat_eta_date < :today
              THEN NVL(cw.hours_logged, 0)
              ELSE 0
            END
          ) AS overdue_hours
        FROM live_issues li
        JOIN employees e
          ON li.assigned_employee_id = e.id
        LEFT JOIN live_issue_components lic
          ON lic.live_issue_id = li.id
        LEFT JOIN component_worklogs cw
          ON cw.task_component_id = lic.live_issue_component_id
        WHERE 1 = 1
        ${sqlCondition}
        GROUP BY
          li.id,
          li.assigned_employee_id,
          li.workload_hours,
          li.status,
          li.uat_eta_date
      `;

      const issueBase = await connection.execute(
        issueBaseSQL,
        {
          today,
          ...visibilityBinds,
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      // =======================================================
      // 4️⃣ LIVE ISSUE LOGS (MONTHLY + LIFETIME)
      // =======================================================
      const issueIds = issueBase.rows.map(r => r.LIVE_ISSUE_ID);
      let issueLogMap = {};

      if (issueIds.length) {
        const issueLogSQL = `
          SELECT
            lic.live_issue_id,
            cw.employee_id,
            SUM(
              CASE 
                WHEN cw.log_date BETWEEN :startDate AND :endDate
                THEN NVL(cw.hours_logged, 0)
                ELSE 0
              END
            ) AS MONTH_LOGGED,
            SUM(NVL(cw.hours_logged, 0)) AS TOTAL_LOGGED
          FROM component_worklogs cw
          JOIN live_issue_components lic
            ON cw.task_component_id = lic.live_issue_component_id
          WHERE lic.live_issue_id IN (${issueIds.map((_, i) => `:lid${i}`).join(",")})
          GROUP BY lic.live_issue_id, cw.employee_id
        `;

        const issueLogBinds = {
          startDate,
          endDate,
          ...issueIds.reduce((a, id, i) => ({ ...a, [`lid${i}`]: id }), {}),
        };

        const logs = await connection.execute(issueLogSQL, issueLogBinds, {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });

        issueLogMap = Object.fromEntries(
          logs.rows.map(r => [
            `${r.LIVE_ISSUE_ID}_${r.EMPLOYEE_ID}`,
            { month: r.MONTH_LOGGED || 0, total: r.TOTAL_LOGGED || 0 },
          ])
        );
      }

      // =======================================================
      // 5️⃣ MERGE TASKS + ISSUES
      // =======================================================
      const workloadMap = {};

      const absorb = (row, logs, type) => {
        const key = `${row.E_ID}-${row.MODULE_ID || "NA"}-${row.PROJECT_ID || "NA"}`;

        if (!workloadMap[key]) {
          workloadMap[key] = {
            e_id: row.E_ID,
            module_id: row.MODULE_ID || null,
            project_id: row.PROJECT_ID || null,
            total: 0,
            completed: 0,
            pending: 0,
            overdue: 0,
            monthLogged: 0,
            task_count: 0,
            issue_count: 0,
          };
        }

        const total = row.TOTAL_HOURS || 0;
        const completed = Math.min(logs.total, total);
        const pending = Math.max(total - completed, 0);

        workloadMap[key].total += total;
        workloadMap[key].completed += completed;
        workloadMap[key].pending += pending;
        workloadMap[key].overdue += row.OVERDUE_HOURS || 0;
        workloadMap[key].monthLogged += logs.month || 0;

        type === "task"
          ? workloadMap[key].task_count++
          : workloadMap[key].issue_count++;
      };

      taskBase.rows.forEach(r =>
        absorb(r, taskLogMap[`${r.TASK_ID}_${r.E_ID}`] || { month: 0, total: 0 }, "task")
      );

      issueBase.rows.forEach(r =>
        absorb(
          r,
          issueLogMap[`${r.LIVE_ISSUE_ID}_${r.E_ID}`] || { month: 0, total: 0 },
          "issue"
        )
      );

      const final = Object.values(workloadMap);

      // =======================================================
      // 6️⃣ ENRICH EMPLOYEE DATA
      // =======================================================
      const empIds = [...new Set(final.map(r => r.e_id))];

      const employees = empIds.length
        ? await connection.execute(
            `SELECT id, name, skills FROM employees WHERE id IN (${empIds
              .map((_, i) => `:e${i}`)
              .join(",")})`,
            empIds.reduce((a, v, i) => ({ ...a, [`e${i}`]: v }), {}),
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
          )
        : { rows: [] };

      const empMap = Object.fromEntries(
        employees.rows.map(e => [e.ID, e])
      );

      // =======================================================
// 6️⃣.5️⃣ ENRICH MODULE & PROJECT NAMES
// =======================================================
const moduleIds = [...new Set(final.map(r => r.module_id).filter(Boolean))];
const projectIds = [...new Set(final.map(r => r.project_id).filter(Boolean))];
// ---- Fetch modules
const modules = moduleIds.length
  ? await connection.execute(
      `SELECT id, name FROM modules
       WHERE id IN (${moduleIds.map((_, i) => `:m${i}`).join(",")})`,
      moduleIds.reduce((a, v, i) => ({ ...a, [`m${i}`]: v }), {}),
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    )
  : { rows: [] };

const moduleMap = Object.fromEntries(
  modules.rows.map(m => [m.ID, m.NAME])
);

// ---- Fetch projects
const projects = projectIds.length
  ? await connection.execute(
      `SELECT id, name FROM projects
       WHERE id IN (${projectIds.map((_, i) => `:p${i}`).join(",")})`,
      projectIds.reduce((a, v, i) => ({ ...a, [`p${i}`]: v }), {}),
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    )
  : { rows: [] };

const projectMap = Object.fromEntries(
  projects.rows.map(p => [p.ID, p.NAME])
);


      // =======================================================
      // 7️⃣ RESPONSE (SEMANTICALLY CORRECT)
      // =======================================================
res.json(
  final.map(r => {
    const emp = empMap[r.e_id] || {};

    const pctTotal = v =>
      r.total ? Math.round((v / r.total) * 100) : 0;

    const pctPending = v =>
      r.pending ? Math.round((v / r.pending) * 100) : 0;

    return {
      employeeId: r.e_id,
      employeeName: emp.NAME || "Unknown",
      skills: emp.SKILLS ? emp.SKILLS.split(",") : [],

      moduleId: r.module_id,
      moduleName: r.module_id ? moduleMap[r.module_id] || "Unknown" : null,

      projectId: r.project_id,
      projectName: r.project_id ? projectMap[r.project_id] || "Unknown" : null,

      taskCount: r.task_count,
      issueCount: r.issue_count,

      summary: {
        totalHours: r.total,
        completedHours: r.completed,
        pendingHours: r.pending,
        overdueHours: r.overdue,
        monthLoggedHours: r.monthLogged,
        percentages: {
          completed: pctTotal(r.completed),
          pending: pctTotal(r.pending),
          overdue: pctPending(r.overdue),
        },
      },
    };
  })
);

    });
  }
);



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

      const user = req.user;
      const { sqlCondition, binds } = buildVisibilityOracle(user, req.query);
      const { applicationId, tlId, zeroHours } = req.query; // 👈 added zeroHours

      let where = "";
      let finalBinds = { ...binds };

      /* ---------------------------------------------------------
         1️⃣ Manager-Owned Visibility
      --------------------------------------------------------- */

      if (user.role === "admin") {
        where = `
          WHERE m.manager_id = (
            SELECT manager_id
            FROM employees
            WHERE id = :currentUserId
          )
        `;
        finalBinds = { currentUserId: user.id };
      } else {
        where = `
          WHERE m.manager_id IN (
            SELECT e.id
            FROM employees e
            WHERE 1=1
            ${sqlCondition}
          )
        `;
      }

      /* ---------------------------------------------------------
         2️⃣ Optional Filters
      --------------------------------------------------------- */

      if (tlId) {
        where += ` AND p.tech_fpr_tl = :tlId`;
        finalBinds.tlId = tlId;
      }

      if (applicationId && applicationId !== "all") {
        where += ` AND m.application_id = :applicationId`;
        finalBinds.applicationId = Number(applicationId);
      }

      finalBinds.today = new Date();
      finalBinds.zeroHours = zeroHours === "true" ? 1 : 0; // 👈 added bind

      /* ---------------------------------------------------------
         3️⃣ Project Summary Query (UPDATED)
      --------------------------------------------------------- */

      const summarySQL = `
        SELECT
          p.id AS "projectId",
          p.name AS "projectName",
          p.PLANNED_END_DATE AS "plannedEndDate",
          p.ON_TRACK_STATUS AS "onTrackStatus",
          p.GO_LIVE_END_DATE AS "goLiveEndDate",
          m.name AS "moduleName",
          p.project_stage AS "projectStage",

          /* ---------------- TASKS ---------------- */
          COUNT(DISTINCT t.task_id) AS "taskCount",
          COUNT(DISTINCT t.e_id) AS "employeeCount",

          SUM(NVL(t.workload_hours, 0)) AS "totalHours",

          SUM(
            CASE 
              WHEN t.status IN ('Live','Preprod_Signoff','Completed') 
              THEN 1 ELSE 0 
            END
          ) AS "completedTasks",

          SUM(
            CASE 
              WHEN t.status IN (
                'Under_Development','Under_UAT','Under_Preprod',
                'UAT_Signoff','Under_QA','WIP'
              )
              THEN 1 ELSE 0 
            END
          ) AS "inProgressTasks",

          SUM(
            CASE 
              WHEN t.status IN (
                'BRS_Discussion','Approach_Preparation',
                'Approach_Finalization','Pending'
              )
              THEN 1 ELSE 0 
            END
          ) AS "pendingTasks",

          SUM(
            CASE 
              WHEN t.status IN (
                'Under_Development','Under_UAT','Under_Preprod',
                'UAT_Signoff','Under_QA','WIP'
              )
              AND t.due_date < :today
              THEN 1 ELSE 0 
            END
          ) AS "overdueInProgress",

          SUM(
            CASE 
              WHEN t.status IN (
                'BRS_Discussion','Approach_Preparation',
                'Approach_Finalization','Pending'
              )
              AND t.due_date < :today
              THEN 1 ELSE 0 
            END
          ) AS "overduePending",

          /* ---------------- LIVE ISSUES ---------------- */
          NVL(li.issueCount, 0) AS "issueCount",
          NVL(li.completedIssues, 0) AS "completedIssues",
          NVL(li.openIssues, 0) AS "openIssues"

        FROM projects p
        JOIN modules m ON p.module_id = m.id

        LEFT JOIN tasks t 
          ON t.project_id = p.id

        /* ✅ SAFE SUBQUERY FOR LIVE ISSUES */
        LEFT JOIN (
          SELECT 
            project_id,
            COUNT(*) AS issueCount,
            SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) AS completedIssues,
            SUM(CASE WHEN status IN ('Open','WIP','Hold') THEN 1 ELSE 0 END) AS openIssues
          FROM LIVE_ISSUES
          GROUP BY project_id
        ) li 
          ON li.project_id = p.id

        ${where}

        GROUP BY
          p.id,
          p.name,
          m.name,
          p.project_stage,
          p.planned_end_date,
          p.on_track_status,
          p.go_live_end_date,
          li.issueCount,
          li.completedIssues,
          li.openIssues

        HAVING (:zeroHours = 0 OR NVL(SUM(t.workload_hours), 0) = 0)

        ORDER BY p.name
      `;

      const summaryResult = await connection.execute(
        summarySQL,
        finalBinds,
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const projects = summaryResult.rows || [];

      if (!projects.length) {
        return res.json({
          projects: [],
          selectedApplication: applicationId || "all",
        });
      }

      /* ---------------------------------------------------------
         4️⃣ Stage Change Logs (UNCHANGED)
      --------------------------------------------------------- */

      const projectIds = projects.map((p) => p.projectId);

      const clobSQL = `
        SELECT 
          id AS "projectId",
          change_log AS "changeLog"
        FROM projects
        WHERE id IN (${projectIds.map((_, i) => `:id${i}`).join(",")})
      `;

      const clobBinds = projectIds.reduce(
        (acc, id, i) => ({ ...acc, [`id${i}`]: id }),
        {}
      );

      const clobResult = await connection.execute(clobSQL, clobBinds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      const stageChangesMap = {};

      for (const row of clobResult.rows) {
        let logs = [];
        try {
          if (row.changeLog) {
            let data =
              row.changeLog instanceof oracledb.Lob
                ? await new Promise((resolve, reject) => {
                    let d = "";
                    row.changeLog.setEncoding("utf8");
                    row.changeLog.on("data", (c) => (d += c));
                    row.changeLog.on("end", () => resolve(d));
                    row.changeLog.on("error", reject);
                  })
                : row.changeLog;

            const parsed = JSON.parse(data);
            logs = Array.isArray(parsed) ? parsed : [parsed];
          }
        } catch {
          logs = [];
        }

        stageChangesMap[row.projectId] = logs
          .filter((e) => e.changes?.project_stage)
          .map((e) => ({
            stage: e.changes.project_stage.new,
            changedAt: e.timestamp,
          }));
      }

      res.json({
        projects: projects.map((p) => ({
          ...p,
          stageChanges: stageChangesMap[p.projectId] || [],
        })),
        selectedApplication: applicationId || "all",
      });
    });
  }
);

//project stage summary
router.get(
  "/project-stage-summary",
  authMiddleware(["admin", "manager", "alt", "lt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {
      const { tlId, applicationName } = req.query;

      const binds = {};
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
      // STEP 1️⃣ — Stage-wise summary based on JSON stage
      // --------------------------------------------------
      const summarySQL = `
        SELECT
          COALESCE(jt.stage, p.project_stage) AS projectStage,

          COUNT(DISTINCT p.id) AS projectCount,

          COUNT(jt.stage) AS modificationCount,

          JSON_ARRAYAGG(
            JSON_OBJECT(
              'stage' VALUE jt.stage,
              'date' VALUE jt.change_date,
              'timestamp' VALUE jt.timestamp,
              'details' VALUE jt.details,
              'updatedBy' VALUE jt.updatedBy
            )
            RETURNING CLOB
          ) AS stageChanges

        FROM projects p

        LEFT JOIN JSON_TABLE(
          p.project_changes_received,
          '$[*]'
          COLUMNS (
            stage        VARCHAR2(50)   PATH '$.stage',
            change_date VARCHAR2(20)   PATH '$.date',
            timestamp   VARCHAR2(50)   PATH '$.timestamp',
            details     VARCHAR2(4000) PATH '$.details',
            updatedBy   VARCHAR2(100)  PATH '$.updatedBy'
          )
        ) jt
          ON 1 = 1

        WHERE 1 = 1
          ${projectFilterSQL}

        GROUP BY
          COALESCE(jt.stage, p.project_stage)

        ORDER BY projectStage
      `;
      const result = await connection.execute(summarySQL, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      // --------------------------------------------------
      // STEP 2️⃣ — Safe CLOB parser
      // --------------------------------------------------
      const parseClobJson = async (clob) => {
        if (!clob) return [];
        if (typeof clob === "string") return JSON.parse(clob);

        let data = "";
        clob.setEncoding("utf8");
        for await (const chunk of clob) data += chunk;
        return JSON.parse(data);
      };

      // --------------------------------------------------
      // STEP 3️⃣ — Normalize all stages
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

      const stageSummary = {};

      for (const stage of allStages) {
        const record = result.rows.find(
          (r) => r.PROJECTSTAGE === stage
        );

        stageSummary[stage] = {
          projectCount: record ? Number(record.PROJECTCOUNT) : 0,
          modificationCount: record ? Number(record.MODIFICATIONCOUNT) : 0,
          stageChanges: record
            ? (await parseClobJson(record.STAGECHANGES)).filter(
                (c) => c.stage !== null
              )
            : [],
        };
      }

      // --------------------------------------------------
      // ✅ FINAL RESPONSE
      // --------------------------------------------------
      res.json({
        stageSummary,
        selectedTL: tlId || "all",
        selectedApplication: applicationName || "all",
      });
    });
  }
);


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
  EXTRACT(MONTH FROM t.completed_at) = :month
  AND EXTRACT(YEAR FROM t.completed_at) = :year
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
