const express = require("express");
const oracledb = require("oracledb");
oracledb.fetchAsString = [oracledb.CLOB];

const authMiddleware = require('../middleware/auth.js');
const { buildVisibilityOracle } = require("../utils/visibilityOracle");
const { safeRoute } = require("../utils/dbWrapper");

const router = express.Router();
// Helpers
function formatDateForDisplay(date) 
{
 if (!date) return null; 
const d = new Date(date); 
const day = String(d.getDate()).padStart(2, "0"); 
const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]; 
const month = monthNames[d.getMonth()]; const year = d.getFullYear(); 
return `${day}-${month}-${year}`; 
}

function formatTaskDates(task) {
  return {
    ...task,
    dueDateRaw: task.dueDate,
    createdAtRaw: task.createdAt,
    updatedAtRaw: task.updatedAt,
    completedAtRaw: task.completedAt,
    dueDate: formatDateForDisplay(task.dueDate),
    createdAt: formatDateForDisplay(task.createdAt),
    updatedAt: formatDateForDisplay(task.updatedAt),
    completedAt: formatDateForDisplay(task.completedAt),
  };
}

function getMonthDateRange(month, year) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return { start, end };
}

function formatHoursToHHMM(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m}m`;
}

// 🗓️ Helper to format date like "21-Oct-2025"
function formatDateForDisplay(date) {
  if (!date) return null;
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, "0");
  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ];
  const month = monthNames[d.getMonth()];
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

// 🧾 Format an array of work logs
function formatLogsDates(logs) {
  return logs.map(log => ({
    ...log,
    LOG_DATE: formatDateForDisplay(log.LOG_DATE)
  }));
}

// Calculate workload
async function calculateWorkload(components = [], connection) {
  // 1️⃣ Fetch all mappings
  const result = await connection.execute(
    `SELECT type, values_json FROM effort_mapping`,
    [],
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );

  // 2️⃣ Parse the JSON into a usable object
  const effortMapping = {};
  for (const row of result.rows) {
    // row.VALUES_JSON is now a string if you used oracledb.fetchAsString = [oracledb.CLOB]
    const values = JSON.parse(row.VALUES_JSON);
    effortMapping[row.TYPE] = values; // { Simple: 0.5, Medium: 1, ... }
  }

  // 3️⃣ Calculate workload
  let workloadHours = 0;
  const processedComponents = components.map((comp) => {
    // Map complexity to hours
    const hoursPerItem = effortMapping[comp.type]?.[comp.complexity] || 0;
    const totalCompHours = (comp.count || 1) * hoursPerItem;
    workloadHours += totalCompHours;

    return {
      ...comp,
      hoursPerItem,
      totalCompHours,
      fileRequired: comp.fileRequired || false,
      fileType: comp.fileRequired ? comp.fileType : null,
    };
  });

  return { workloadHours, processedComponents };
}


//route to create a live issue
router.post(
  "/",
  authMiddleware(["admin", "manager", "alt", "lt", "head_lt", "employee"]),
  async (req, res) => {
    return safeRoute(req, res, async (conn) => {
      conn.autoCommit = false;

      const {
        applicationName,
        moduleName,
        subModule,
        reportedBy,
        reportingGroup,
        shortDescription,
        issueDetails,
        category,
        priority,
        status = "Open",
        remarks,
        assignedEmployeeId,
        uatEtaDate,
        fixDate,
        components = []
      } = req.body;

    // ------------------------------------------------------------
// 🔐 EMPLOYEE SELF-ASSIGNMENT BYPASS
// ------------------------------------------------------------
console.log("Assigned Employee ID:", assignedEmployeeId, "User ID:", req.user.id);
if (
  req.user.role === "employee" &&
  Number(assignedEmployeeId) === Number(req.user.id)
) {
  // Allowed — skip visibility check
} else {
  // ------------------------------------------------------------
  // 1️⃣ VISIBILITY CHECK (assigning developer)
  // ------------------------------------------------------------
  const { sqlCondition, binds } = buildVisibilityOracle(req.user, req.body);
  binds.employeeId = assignedEmployeeId;

  const visibilityQuery = `
    SELECT e.id
    FROM employees e
    WHERE e.id = :employeeId
    ${sqlCondition}
  `;

  const vis = await conn.execute(visibilityQuery, binds, {
    outFormat: oracledb.OUT_FORMAT_OBJECT,
  });

  if (!vis.rows.length) {
    await conn.rollback();
    return res.status(403).json({
      error: "You are not authorized to assign this employee.",
    });
  }
}


      // ------------------------------------------------------------
      // 2️⃣ WORKLOAD + COMPONENT PROCESSING (REUSED)
      // ------------------------------------------------------------
      let workloadHours = 0;
      let processedComponents = [];

      if (components.length > 0) {
        const r = await calculateWorkload(components, conn);
        workloadHours = r.workloadHours;
        processedComponents = r.processedComponents;
      }

      // ------------------------------------------------------------
      // 3️⃣ INSERT LIVE ISSUE (SEQ_LIVE_ISSUE)
      // ------------------------------------------------------------
      const insertLiveIssueSql = `
        INSERT INTO LIVE_ISSUES (
          ID,
          APPLICATION_NAME,
          MODULE_NAME,
          SUB_MODULE,
          REPORTED_BY,
          REPORTING_GROUP,
          SHORT_DESCRIPTION,
          ISSUE_DETAILS,
          CATEGORY,
          PRIORITY,
          STATUS,
          REMARKS,
          ASSIGNED_EMPLOYEE_ID,
          UAT_ETA_DATE,
          FIX_DATE,
          WORKLOAD_HOURS,
          CREATED_AT,
          UPDATED_AT
        )
        VALUES (
          SEQ_LIVE_ISSUES.NEXTVAL,
          :applicationName,
          :moduleName,
          :subModule,
          :reportedBy,
          :reportingGroup,
          :shortDescription,
          :issueDetails,
          :category,
          :priority,
          :status,
          :remarks,
          :assignedEmployeeId,
          :uatEtaDate,
          :fixDate,
          :workloadHours,
          SYSTIMESTAMP,
          SYSTIMESTAMP
        )
        RETURNING ID INTO :liveIssueId
      `;

      const liveIssueResult = await conn.execute(insertLiveIssueSql, {
        applicationName,
        moduleName,
        subModule,
        reportedBy,
        reportingGroup,
        shortDescription,
        issueDetails,
        category,
        priority: priority || "Medium",
        status,
        remarks,
        assignedEmployeeId,
        uatEtaDate: uatEtaDate ? new Date(uatEtaDate) : null,
        fixDate: fixDate ? new Date(fixDate) : null,
        workloadHours,
        liveIssueId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }
      });

      const liveIssueId = liveIssueResult.outBinds.liveIssueId[0];

      // ------------------------------------------------------------
      // 4️⃣ INSERT LIVE ISSUE COMPONENTS
      // ⚠️ USE SHARED SEQUENCE (CRITICAL)
      // ------------------------------------------------------------
      for (const c of processedComponents) {
        await conn.execute(
          `
          INSERT INTO LIVE_ISSUE_COMPONENTS (
            LIVE_ISSUE_COMPONENT_ID,
            LIVE_ISSUE_ID,
            TYPE,
            COMPLEXITY,
            COUNT,
            HOURS_PER_ITEM,
            TOTAL_COMP_HOURS,
            STATUS
            
          )
          VALUES (
            SEQ_TASK_COMPONENT.NEXTVAL,
            :liveIssueId,
            :type,
            :complexity,
            :count,
            :hoursPerItem,
            :totalCompHours,
            'Open'
            
          )
          `,
          {
            liveIssueId,
            type: c.type,
            complexity: c.complexity,
            count: c.count,
            hoursPerItem: c.hoursPerItem,
            totalCompHours: c.totalCompHours
          }
        );
      }

      // ------------------------------------------------------------
      // 5️⃣ COMMIT
      // ------------------------------------------------------------
      await conn.commit();

      // ------------------------------------------------------------
      // 6️⃣ FETCH & RETURN LIVE ISSUE
      // ------------------------------------------------------------
      const fetchSql = `
        SELECT
          li.*,
          e.NAME AS ASSIGNED_EMPLOYEE_NAME
        FROM LIVE_ISSUES li
        LEFT JOIN EMPLOYEES e
          ON li.ASSIGNED_EMPLOYEE_ID = e.ID
        WHERE li.ID = :liveIssueId
      `;

      const result = await conn.execute(
        fetchSql,
        { liveIssueId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      return res.json(result.rows[0]);
    });
  }
);

//route to get all live issues
router.get(
  "/",
  authMiddleware(["admin", "manager", "lt", "alt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {

      const {
        status,
        priority,
        employeeId,
        moduleName,
        applicationName,
        month,
        year,
        sortBy,
      } = req.query;

      // -------------------------------------------------------------------------
      // STEP 1️⃣ — Visibility filter
      // -------------------------------------------------------------------------
      const { sqlCondition, binds } = buildVisibilityOracle(req.user, req.query);

      // -------------------------------------------------------------------------
      // STEP 2️⃣ — Dynamic filters
      // -------------------------------------------------------------------------
      const whereClauses = [];

      if (status && status !== "all") {
        whereClauses.push("li.STATUS = :status");
        binds.status = status;
      }

      if (priority && priority !== "all") {
        whereClauses.push("li.PRIORITY = :priority");
        binds.priority = priority;
      }

      if (employeeId) {
        whereClauses.push("li.ASSIGNED_EMPLOYEE_ID = :employeeId");
        binds.employeeId = Number(employeeId);
      }

      if (moduleName) {
        whereClauses.push("li.MODULE_NAME = :moduleName");
        binds.moduleName = moduleName;
      }

      if (applicationName) {
        whereClauses.push("li.APPLICATION_NAME = :applicationName");
        binds.applicationName = applicationName;
      }

      // -------------------------------------------------------------------------
      // STEP 3️⃣ — Month/year filter (reported date OR worklog activity)
      // -------------------------------------------------------------------------
      if (month && year) {
        const { start, end } = getMonthDateRange(Number(month), Number(year));
        whereClauses.push(`
          (
            li.CREATED_AT BETWEEN :startDate AND :endDate
            OR li.ID IN (
              SELECT DISTINCT lic.LIVE_ISSUE_ID
              FROM COMPONENT_WORKLOGS wl
              JOIN LIVE_ISSUE_COMPONENTS lic
                ON wl.TASK_COMPONENT_ID = lic.LIVE_ISSUE_COMPONENT_ID
              WHERE wl.LOG_DATE BETWEEN :startDate AND :endDate
            )
          )
        `);
        binds.startDate = start;
        binds.endDate = end;
      }

      if (sqlCondition) whereClauses.push(sqlCondition.replace(/^ AND /, ""));

      const whereSQL = whereClauses.length
        ? "WHERE " + whereClauses.join(" AND ")
        : "";

      // -------------------------------------------------------------------------
      // STEP 4️⃣ — Sorting
      // -------------------------------------------------------------------------
      let orderBy = "ORDER BY li.CREATED_AT DESC";
      if (sortBy === "createdAtAsc") orderBy = "ORDER BY li.CREATED_AT ASC";
      else if (sortBy === "createdAtDesc") orderBy = "ORDER BY li.CREATED_AT DESC";
      else if (sortBy === "priorityAsc") orderBy = "ORDER BY li.PRIORITY ASC";
      else if (sortBy === "priorityDesc") orderBy = "ORDER BY li.PRIORITY DESC";

      // -------------------------------------------------------------------------
      // STEP 5️⃣ — Main live issues query
      // -------------------------------------------------------------------------
      const sql = `
        SELECT
          li.*,
          e.NAME AS EMPLOYEE_NAME,
          e.DESIGNATION AS EMPLOYEE_DESIGNATION,
          e.EMAIL AS EMPLOYEE_EMAIL
        FROM LIVE_ISSUES li
        LEFT JOIN EMPLOYEES e
          ON li.ASSIGNED_EMPLOYEE_ID = e.ID
        ${whereSQL}
        ${orderBy}
      `;

      const result = await connection.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      if (!result.rows || result.rows.length === 0) {
        return res.json([]);
      }

      // -------------------------------------------------------------------------
      // STEP 6️⃣ — Map live issues
      // -------------------------------------------------------------------------
      let liveIssues = result.rows.map((row) => ({
        liveIssueId: row.ID,
        dateReported:row.DATE_REPORTED,
        applicationName: row.APPLICATION_NAME,
        moduleName: row.MODULE_NAME,
        subModuleName: row.SUB_MODULE,
        shortDescription: row.SHORT_DESCRIPTION,
        issueDetails: row.ISSUE_DETAILS,
        category: row.CATEGORY,
        priority: row.PRIORITY,
        status: row.STATUS,
        reportedBy: row.REPORTED_BY,
        reportingGroup: row.REPORTING_GROUP,
        uatEtaDate: row.UAT_ETA_DATE,
        vintage: row.VINTAGE,
        remarks: row.REMARKS,
        workloadHours: row.WORKLOAD_HOURS,
        workloadHoursHHMM: formatHoursToHHMM(row.WORKLOAD_HOURS),
        employeeId: row.ASSIGNED_EMPLOYEE_ID,
        employeeName: row.EMPLOYEE_NAME,
        employeeDesignation: row.EMPLOYEE_DESIGNATION,
        employeeEmail: row.EMPLOYEE_EMAIL,
        createdAt: row.CREATED_AT,
        updatedAt: row.UPDATED_AT,
      }));

      // -------------------------------------------------------------------------
      // STEP 7️⃣ — Fetch components
      // -------------------------------------------------------------------------
      const liveIssueIds = liveIssues.map((l) => l.liveIssueId);

      const compQuery = `
        SELECT
          lic.LIVE_ISSUE_COMPONENT_ID,
          lic.LIVE_ISSUE_ID,
          lic.TYPE,
          lic.COMPLEXITY,
          lic.COUNT,
          lic.HOURS_PER_ITEM,
          lic.TOTAL_COMP_HOURS,
          lic.STATUS,

          -- 🟢 Lifetime logged hours
          (
            SELECT NVL(SUM(wl.HOURS_LOGGED), 0)
            FROM COMPONENT_WORKLOGS wl
            WHERE wl.TASK_COMPONENT_ID = lic.LIVE_ISSUE_COMPONENT_ID
          ) AS CUMULATIVE_LOGGED_HOURS,

          -- 🔵 Month specific
          (
            SELECT NVL(SUM(wl.HOURS_LOGGED), 0)
            FROM COMPONENT_WORKLOGS wl
            WHERE wl.TASK_COMPONENT_ID = lic.LIVE_ISSUE_COMPONENT_ID
            ${month && year ? "AND wl.LOG_DATE BETWEEN :startDate AND :endDate" : ""}
          ) AS LOGGED_HOURS

        FROM LIVE_ISSUE_COMPONENTS lic
        WHERE lic.LIVE_ISSUE_ID IN (${liveIssueIds.map((_, i) => `:lid${i}`).join(",")})
      `;

      const compBinds = liveIssueIds.reduce(
        (acc, id, i) => ({ ...acc, [`lid${i}`]: id }),
        {}
      );

      if (month && year) {
        const { start, end } = getMonthDateRange(Number(month), Number(year));
        compBinds.startDate = start;
        compBinds.endDate = end;
      }

      const compResult = await connection.execute(compQuery, compBinds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      const components = compResult.rows || [];

      // -------------------------------------------------------------------------
      // STEP 8️⃣ — Fetch worklogs
      // -------------------------------------------------------------------------
      const worklogsQuery = `
        SELECT
          wl.TASK_COMPONENT_ID,
          wl.LOG_DATE,
          wl.HOURS_LOGGED,
          wl.NOTES
        FROM COMPONENT_WORKLOGS wl
        WHERE wl.TASK_COMPONENT_ID IN (
          SELECT LIVE_ISSUE_COMPONENT_ID
          FROM LIVE_ISSUE_COMPONENTS
          WHERE LIVE_ISSUE_ID IN (${liveIssueIds.map((_, i) => `:lid${i}`).join(",")})
        )
        ${month && year ? "AND wl.LOG_DATE BETWEEN :startDate AND :endDate" : ""}
        ORDER BY wl.TASK_COMPONENT_ID, wl.LOG_DATE DESC
      `;

      const worklogsResult = await connection.execute(
        worklogsQuery,
        compBinds,
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const worklogs = worklogsResult.rows || [];

      // -------------------------------------------------------------------------
      // STEP 9️⃣ — Attach components & worklogs
      // -------------------------------------------------------------------------
      liveIssues = liveIssues.map((issue) => {
        const issueComps = components.filter(
          (c) => c.LIVE_ISSUE_ID === issue.liveIssueId
        );

        issue.components = issueComps.map((c) => ({
          id: c.LIVE_ISSUE_COMPONENT_ID,
          type: c.TYPE,
          complexity: c.COMPLEXITY,
          count: c.COUNT,
          status: c.STATUS,
          hoursPerItem: c.HOURS_PER_ITEM,
          totalCompHours: c.TOTAL_COMP_HOURS,

          loggedHours: c.LOGGED_HOURS || 0,
          cumulativeLoggedHours: c.CUMULATIVE_LOGGED_HOURS || 0,

          hoursPerItemHHMM: formatHoursToHHMM(c.HOURS_PER_ITEM),
          totalCompHoursHHMM: formatHoursToHHMM(c.TOTAL_COMP_HOURS),

          worklogs: worklogs
            .filter((wl) => wl.TASK_COMPONENT_ID === c.LIVE_ISSUE_COMPONENT_ID)
            .map((wl) => ({
              logDate: wl.LOG_DATE,
              hoursLogged: wl.HOURS_LOGGED,
              hoursLoggedHHMM: formatHoursToHHMM(wl.HOURS_LOGGED),
              notes: wl.NOTES,
            })),
        }));

        return issue;
      });

      // -------------------------------------------------------------------------
      // ✅ FINAL RESPONSE
      // -------------------------------------------------------------------------
      res.json(liveIssues);
    });
  }
);

//route to get a live issue by id
router.get(
  "/employee/:id",
  authMiddleware(["employee", "admin", "manager", "alt", "lt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {

      const completedStatuses = ["Completed", "Live", "Preprod_Signoff"];
      const { status, month, year, sortBy } = req.query;
      const empId = Number(req.params.id);
      const user = req.user;

      // -------------------------------------------------------------------------
      // STEP 1️⃣ — Role-based access control
      // -------------------------------------------------------------------------
      if (user.role.toLowerCase() === "employee" && empId !== user.id) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      // -------------------------------------------------------------------------
      // STEP 2️⃣ — Centralized visibility
      // -------------------------------------------------------------------------
      const { sqlCondition, binds } = buildVisibilityOracle(user, req.query);
      const whereClauses = ["li.ASSIGNED_EMPLOYEE_ID = :empId"];
      binds.empId = empId;

      // -------------------------------------------------------------------------
      // STEP 3️⃣ — Status group filter
      // -------------------------------------------------------------------------
      const statusGroups = {
        Pending: ["Pending", "BRS_Discussion"],
        WIP: ["Under_Investigation", "Under_Fix", "Under_UAT", "WIP"],
        Completed: ["Live", "Preprod_Signoff", "Completed"],
        Hold: ["Hold", "Dropped"],
      };

      if (status && status !== "all" && statusGroups[status]) {
        whereClauses.push(
          `li.STATUS IN (${statusGroups[status].map((_, i) => `:s${i}`).join(",")})`
        );
        statusGroups[status].forEach((s, i) => (binds[`s${i}`] = s));
      }

      // -------------------------------------------------------------------------
      // STEP 4️⃣ — Month/year filter (reported OR worklog activity)
      // -------------------------------------------------------------------------
      if (month && year) {
        const { start, end } = getMonthDateRange(Number(month), Number(year));
        whereClauses.push(`
          (
            li.CREATED_AT BETWEEN :startDate AND :endDate
            OR li.ID IN (
              SELECT DISTINCT lic.LIVE_ISSUE_ID
              FROM COMPONENT_WORKLOGS wl
              JOIN LIVE_ISSUE_COMPONENTS lic
                ON wl.TASK_COMPONENT_ID = lic.LIVE_ISSUE_COMPONENT_ID
              WHERE wl.LOG_DATE BETWEEN :startDate AND :endDate
            )
          )
        `);
        binds.startDate = start;
        binds.endDate = end;
      }

      if (sqlCondition) whereClauses.push(sqlCondition.replace(/^ AND /, ""));

      const whereSQL =
        whereClauses.length > 0
          ? "WHERE " + whereClauses.join(" AND ")
          : "";

      // -------------------------------------------------------------------------
      // STEP 5️⃣ — Sorting
      // -------------------------------------------------------------------------
      let orderBy = "ORDER BY li.CREATED_AT DESC";
      if (sortBy === "createdAtAsc") orderBy = "ORDER BY li.CREATED_AT ASC";
      else if (sortBy === "createdAtDesc") orderBy = "ORDER BY li.CREATED_AT DESC";

      // -------------------------------------------------------------------------
      // STEP 6️⃣ — Fetch live issues
      // -------------------------------------------------------------------------
      const sql = `
        SELECT
          li.*,
          e.NAME AS EMPLOYEE_NAME,
          e.DESIGNATION AS EMPLOYEE_DESIGNATION,
          e.EMAIL AS EMPLOYEE_EMAIL
        FROM LIVE_ISSUES li
        LEFT JOIN EMPLOYEES e
          ON li.ASSIGNED_EMPLOYEE_ID = e.ID
        ${whereSQL}
        ${orderBy}
      `;

      const result = await connection.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      if (!result.rows || result.rows.length === 0) {
        return res.json([]);
      }

      // -------------------------------------------------------------------------
      // STEP 7️⃣ — Map live issues
      // -------------------------------------------------------------------------
      let liveIssues = result.rows.map((row) => ({
        liveIssueId: row.ID,
        dateReported:row.DATE_REPORTED,
        applicationName: row.APPLICATION_NAME,
        moduleName: row.MODULE_NAME,
        subModule: row.SUB_MODULE,
        shortDescription: row.SHORT_DESCRIPTION,
        issueDetails: row.ISSUE_DETAILS,
        category: row.CATEGORY,
        priority: row.PRIORITY,
        status: row.STATUS,
        remarks: row.REMARKS,
        workloadHours: row.WORKLOAD_HOURS,
        workloadHoursHHMM: formatHoursToHHMM(row.WORKLOAD_HOURS),
        employeeId: row.ASSIGNED_EMPLOYEE_ID,
        employeeName: row.EMPLOYEE_NAME,
        employeeDesignation: row.EMPLOYEE_DESIGNATION,
        employeeEmail: row.EMPLOYEE_EMAIL,
        createdAt: row.CREATED_AT,
        updatedAt: row.UPDATED_AT,
      }));

      // -------------------------------------------------------------------------
      // STEP 8️⃣ — Fetch components
      // -------------------------------------------------------------------------
      const liveIssueIds = liveIssues.map((l) => l.liveIssueId);

      const compQuery = `
        SELECT
          lic.LIVE_ISSUE_COMPONENT_ID,
          lic.LIVE_ISSUE_ID,
          lic.TYPE,
          lic.COMPLEXITY,
          lic.COUNT,
          lic.HOURS_PER_ITEM,
          lic.TOTAL_COMP_HOURS,
          lic.STATUS,

          -- 🟢 Lifetime
          (
            SELECT NVL(SUM(wl.HOURS_LOGGED), 0)
            FROM COMPONENT_WORKLOGS wl
            WHERE wl.TASK_COMPONENT_ID = lic.LIVE_ISSUE_COMPONENT_ID
          ) AS CUMULATIVE_LOGGED_HOURS,

          -- 🔵 Monthly
          (
            SELECT NVL(SUM(wl.HOURS_LOGGED), 0)
            FROM COMPONENT_WORKLOGS wl
            WHERE wl.TASK_COMPONENT_ID = lic.LIVE_ISSUE_COMPONENT_ID
            ${month && year ? "AND wl.LOG_DATE BETWEEN :startDate AND :endDate" : ""}
          ) AS LOGGED_HOURS

        FROM LIVE_ISSUE_COMPONENTS lic
        WHERE lic.LIVE_ISSUE_ID IN (${liveIssueIds
          .map((_, i) => `:lid${i}`)
          .join(",")})
      `;

      const compBinds = liveIssueIds.reduce(
        (acc, id, i) => ({ ...acc, [`lid${i}`]: id }),
        {}
      );

      if (month && year) {
        const { start, end } = getMonthDateRange(Number(month), Number(year));
        compBinds.startDate = start;
        compBinds.endDate = end;
      }

      const compResult = await connection.execute(compQuery, compBinds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });

      const components = compResult.rows || [];

      // -------------------------------------------------------------------------
      // STEP 9️⃣ — Fetch worklogs
      // -------------------------------------------------------------------------
      const worklogsQuery = `
        SELECT
          wl.TASK_COMPONENT_ID,
          wl.LOG_DATE,
          wl.HOURS_LOGGED,
          wl.NOTES
        FROM COMPONENT_WORKLOGS wl
        WHERE wl.TASK_COMPONENT_ID IN (
          SELECT LIVE_ISSUE_COMPONENT_ID
          FROM LIVE_ISSUE_COMPONENTS
          WHERE LIVE_ISSUE_ID IN (${liveIssueIds
            .map((_, i) => `:lid${i}`)
            .join(",")})
        )
        ${month && year ? "AND wl.LOG_DATE BETWEEN :startDate AND :endDate" : ""}
        ORDER BY wl.TASK_COMPONENT_ID, wl.LOG_DATE DESC
      `;

      const worklogsResult = await connection.execute(
        worklogsQuery,
        compBinds,
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const worklogs = worklogsResult.rows || [];

      // -------------------------------------------------------------------------
      // STEP 🔟 — Attach components & worklogs
      // -------------------------------------------------------------------------
      liveIssues = liveIssues.map((issue) => {
        const issueComps = components.filter(
          (c) => c.LIVE_ISSUE_ID === issue.liveIssueId
        );

        issue.components = issueComps.map((c) => ({
          id: c.LIVE_ISSUE_COMPONENT_ID,
          type: c.TYPE,
          complexity: c.COMPLEXITY,
          count: c.COUNT,
          status: c.STATUS,
          hoursPerItem: c.HOURS_PER_ITEM,
          totalCompHours: c.TOTAL_COMP_HOURS,

          loggedHours: c.LOGGED_HOURS || 0,
          cumulativeLoggedHours: c.CUMULATIVE_LOGGED_HOURS || 0,

          hoursPerItemHHMM: formatHoursToHHMM(c.HOURS_PER_ITEM),
          totalCompHoursHHMM: formatHoursToHHMM(c.TOTAL_COMP_HOURS),

          worklogs: worklogs
            .filter((wl) => wl.TASK_COMPONENT_ID === c.LIVE_ISSUE_COMPONENT_ID)
            .map((wl) => ({
              logDate: wl.LOG_DATE,
              hoursLogged: wl.HOURS_LOGGED,
              hoursLoggedHHMM: formatHoursToHHMM(wl.HOURS_LOGGED),
              notes: wl.NOTES,
            })),
        }));

        return issue;
      });

      // -------------------------------------------------------------------------
      // ✅ FINAL RESPONSE
      // -------------------------------------------------------------------------
      return res.json(liveIssues);
    });
  }
);

router.get(
  "/employeeSummary/:empId",
  authMiddleware(["admin", "manager", "alt", "lt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (conn) => {
      const { empId } = req.params;
      const { status, month, year } = req.query;

      if (!month || !year) {
        return res.status(400).json({ error: "month and year required" });
      }

      // -------------------------------------------------------
      // Month date range (JS Date objects)
      // -------------------------------------------------------
      const { start, end } = getMonthDateRange(Number(month), Number(year));

const binds = {
  empId,
  startDate: start,
  endDate: end,
};


      // -------------------------------------------------------
      // Optional status filter (case-safe)
      // -------------------------------------------------------
let statusSQL = "";
if (status) {
  // Normalize UI → DB status
  let dbStatus = status;

  if (status === "Closed") {
    dbStatus = "Completed";
  }

  statusSQL = `AND UPPER(li.status) = UPPER(:status)`;
  binds.status = dbStatus;
}

      // -------------------------------------------------------
      // SQL
      // -------------------------------------------------------
      const sql = `
        SELECT
          li.id,
          li.short_description,
          li.issue_details,
          li.application_name,
          li.module_name,
          li.status,
          li.uat_eta_date,
          li.fix_date,
          li.closed_at,
          li.completed_at,
          NVL(li.workload_hours, 0) AS workload_hours
        FROM live_issues li
        JOIN employees e
          ON li.assigned_employee_id = e.id
        WHERE li.assigned_employee_id = :empId
          ${statusSQL}
          AND (
            TRUNC(li.uat_eta_date)
              BETWEEN :startDate AND :endDate
            OR EXISTS (
              SELECT 1
              FROM component_worklogs cw
              JOIN live_issue_components lic
                ON cw.task_component_id = lic.live_issue_component_id
              WHERE lic.live_issue_id = li.id
                AND TRUNC(cw.log_date)
                    BETWEEN :startDate AND :endDate
            )
          )
        ORDER BY
          li.uat_eta_date NULLS LAST,
          li.created_at DESC
      `;

      const result = await conn.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      res.json(
        result.rows.map((r) => ({
          id: r.ID,
          shortDescription: r.SHORT_DESCRIPTION,
          issueDetails: r.ISSUE_DETAILS,
          applicationName: r.APPLICATION_NAME,
          moduleName: r.MODULE_NAME,
          status: r.STATUS,
          uatEtaDate: r.UAT_ETA_DATE
            ? formatDateForDisplay(r.UAT_ETA_DATE)
            : null,
          fixDate: r.FIX_DATE
            ? formatDateForDisplay(r.FIX_DATE)
            : null,
          closedAt: r.CLOSED_AT
            ? formatDateForDisplay(r.CLOSED_AT)
            : null,
          workloadHours: r.WORKLOAD_HOURS,
          completedAt: r.COMPLETED_AT
            ? formatDateForDisplay(r.COMPLETED_AT)
            : null,
        }))
      );
    });
  }
);




//route to update a live issue by id
router.patch(
  "/:id",
  authMiddleware(["admin", "manager", "employee", "alt", "lt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {
      const user = req.user;
      const taskId = Number(req.params.id);

      // -------------------------------------------------------------------------
      // STEP 1️⃣ — Fetch existing task and validate existence
      // -------------------------------------------------------------------------
      const taskResult = await connection.execute(
        `SELECT * FROM LIVE_ISSUES WHERE ID = :id`,
        { id: taskId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      if (!taskResult.rows.length) {
        return res.status(404).json({ error: "Task not found" });
      }

      const task = taskResult.rows[0];

      // -------------------------------------------------------------------------
      // STEP 2️⃣ — Role-based access check
      // -------------------------------------------------------------------------
      const empResult = await connection.execute(
        `SELECT MANAGER_ID, ROLE FROM EMPLOYEES WHERE ID = :eid`,
        { eid: task.ASSIGNED_EMPLOYEE_ID },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const emp = empResult.rows[0];
      const isManagerOfTask = emp?.MANAGER_ID === user.id;
      const isTaskOwner = task.ASSIGNED_EMPLOYEE_ID === user.id;

      if (user.role === "employee" && !isTaskOwner) {
        return res.status(403).json({ error: "Access denied" });
      }

      if (user.role === "manager" && !isManagerOfTask && !isTaskOwner) {
        return res.status(403).json({ error: "Access denied" });
      }

      if (user.role === "admin" && emp?.MANAGER_ID !== user.managerId) {
        return res.status(403).json({ error: "Access denied" });
      }

      // -------------------------------------------------------------------------
      // STEP 3️⃣ — Prepare update payload
      // -------------------------------------------------------------------------
      let updateData = { ...req.body };
      // -------------------------------------------------------------------------
      // STEP 4️⃣ — Handle component updates
      // -------------------------------------------------------------------------
      if (Array.isArray(req.body.components)) {
        const { workloadHours, processedComponents } =
          await calculateWorkload(req.body.components, connection);

        updateData.WORKLOAD_HOURS = workloadHours;

        const existingCompsResult = await connection.execute(
          `SELECT LIVE_ISSUE_COMPONENT_ID FROM LIVE_ISSUE_COMPONENTS WHERE LIVE_ISSUE_ID = :taskId`,
          { taskId },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        const existingCompIds = existingCompsResult.rows.map((r) =>
          r.LIVE_ISSUE_COMPONENT_ID.toString()
        );

        const incomingCompIds = [];

        for (const comp of processedComponents) {
          const compId = comp.id || comp.LIVE_ISSUE_COMPONENT_ID || null;

          const bindData = {
            taskId,
            type: comp.type,
            complexity: comp.complexity,
            count: comp.count,
            hoursPerItem: comp.hoursPerItem,
            totalCompHours: comp.totalCompHours,
            fileRequired: comp.fileRequired ? 1 : 0,
            fileType: comp.fileType || null,
          };

          if (compId && existingCompIds.includes(compId.toString())) {
            incomingCompIds.push(compId.toString());

            await connection.execute(
              `
              UPDATE LIVE_ISSUE_COMPONENTS SET
                TYPE = :type,
                COMPLEXITY = :complexity,
                COUNT = :count,
                HOURS_PER_ITEM = :hoursPerItem,
                TOTAL_COMP_HOURS = :totalCompHours,
                FILE_REQUIRED = :fileRequired,
                FILE_TYPE = :fileType,
                UPDATED_AT = SYSTIMESTAMP
              WHERE LIVE_ISSUE_COMPONENT_ID = :compId
                AND LIVE_ISSUE_ID = :taskId
              `,
              { ...bindData, compId },
              { autoCommit: false }
            );
          } else {
            await connection.execute(
              `
              INSERT INTO LIVE_ISSUE_COMPONENTS
                (LIVE_ISSUE_COMPONENT_ID, LIVE_ISSUE_ID, TYPE, COMPLEXITY, COUNT,
                 HOURS_PER_ITEM, TOTAL_COMP_HOURS, FILE_REQUIRED, FILE_TYPE)
              VALUES
                (SEQ_TASK_COMPONENT.NEXTVAL, :taskId, :type, :complexity,
                 :count, :hoursPerItem, :totalCompHours, :fileRequired, :fileType)
              `,
              bindData,
              { autoCommit: false }
            );
          }
        }

        const compIdsToDelete = existingCompIds.filter(
          (id) => !incomingCompIds.includes(id)
        );

        if (compIdsToDelete.length) {
          const deleteBinds = { taskId };
          const placeholders = compIdsToDelete.map((id, i) => {
            deleteBinds[`id${i}`] = id;
            return `:id${i}`;
          });

          await connection.execute(
            `
            DELETE FROM LIVE_ISSUE_COMPONENTS
            WHERE LIVE_ISSUE_ID = :taskId
              AND LIVE_ISSUE_COMPONENT_ID IN (${placeholders.join(",")})
            `,
            deleteBinds,
            { autoCommit: false }
          );
        }

        await connection.commit();
      }
      const fieldMap = {
  employeeId: "E_ID",
  projectId: "PROJECT_ID",
  moduleId: "MODULE_ID",
  title: "TITLE",
  description: "DESCRIPTION",
  dueDate: "DUE_DATE",
  priority: "PRIORITY",
  status: "STATUS",
  WORKLOAD_HOURS: "WORKLOAD_HOURS",
  completedAt: "COMPLETED_AT",
};

      // -------------------------------------------------------------------------
      // STEP 5️⃣ — FIXED normal task update (this was the bug)
      // -------------------------------------------------------------------------
      const setClauses = [];
const binds = { taskId };

// normalize dates
if (updateData.dueDate) {
  updateData.dueDate = new Date(updateData.dueDate);
}
if (updateData.completedAt) {
  updateData.completedAt = new Date(updateData.completedAt);
}

Object.entries(updateData).forEach(([key, value]) => {
  const dbColumn = fieldMap[key] || fieldMap[key.toUpperCase()];
  if (!dbColumn) return;

  setClauses.push(`${dbColumn} = :${key}`);
  binds[key] = value;
});

setClauses.push("UPDATED_AT = SYSTIMESTAMP");

if (setClauses.length === 1) {
  return res.status(400).json({ error: "No valid task fields to update" });
}

const updateSQL = `
  UPDATE LIVE_ISSUES
  SET ${setClauses.join(", ")}
  WHERE ID = :taskId
`;

await connection.execute(updateSQL, binds, { autoCommit: true });


      // -------------------------------------------------------------------------
      // STEP 6️⃣ — Fetch updated task
      // -------------------------------------------------------------------------
      const updatedTaskResult = await connection.execute(
        `
        SELECT 
          t.*, 
          e.NAME AS EMPLOYEE_NAME,
          e.DESIGNATION AS EMPLOYEE_DESIGNATION
        FROM LIVE_ISSUES t
        LEFT JOIN EMPLOYEES e ON t.ASSIGNED_EMPLOYEE_ID = e.ID
        WHERE t.ID = :taskId
        `,
        { taskId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      res.json(formatTaskDates(updatedTaskResult.rows[0]));
    });
  }
);

//route to update status of live issue by id
router.patch(
  "/:id/status",
  authMiddleware(["admin", "manager", "employee", "alt", "lt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {
      const user = req.user;
      const { id } = req.params; // LIVE_ISSUE_COMPONENT_ID
      const { status, type } = req.body;

      // -------------------------------------------------------------------------
      // STEP 1️⃣ — Validate request type
      // -------------------------------------------------------------------------
      if (type !== "component") {
        return res
          .status(400)
          .json({ error: "Live-issue-level status updates are not allowed" });
      }

      // -------------------------------------------------------------------------
      // STEP 2️⃣ — Fetch component + live issue + employee
      // -------------------------------------------------------------------------
      const compResult = await connection.execute(
        `
        SELECT 
          c.*,
          li.ID AS LIVE_ISSUE_ID,
          li.ASSIGNED_EMPLOYEE_ID,
          e.MANAGER_ID,
          c.TOTAL_COMP_HOURS,
          c.COMPLETED_AT
        FROM LIVE_ISSUE_COMPONENTS c
        JOIN LIVE_ISSUES li ON c.LIVE_ISSUE_ID = li.ID
        JOIN EMPLOYEES e ON li.ASSIGNED_EMPLOYEE_ID = e.ID
        WHERE c.LIVE_ISSUE_COMPONENT_ID = :id
        `,
        { id },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      if (!compResult.rows.length) {
        return res.status(404).json({ error: "Component not found" });
      }

      const comp = compResult.rows[0];

      // -------------------------------------------------------------------------
      // STEP 3️⃣ — Role-based access verification
      // -------------------------------------------------------------------------
      const isOwner = comp.ASSIGNED_EMPLOYEE_ID?.toString() === user.id?.toString();
      const isManager = comp.MANAGER_ID?.toString() === user.id?.toString();

      if (user.role === "employee" && !isOwner) {
        return res.status(403).json({ error: "Access denied" });
      }

      if (user.role === "manager" && !isManager && !isOwner) {
        return res.status(403).json({ error: "Access denied" });
      }

      if (user.role === "admin" && comp.MANAGER_ID !== user.managerId) {
        return res.status(403).json({ error: "Access denied" });
      }

      // -------------------------------------------------------------------------
      // STEP 4️⃣ — Update component status
      // -------------------------------------------------------------------------
      const completedStatuses = ["Live", "Preprod_Signoff"];
      const binds = { status, updatedAt: new Date(), id };
      let completedAtClause = "";

      if (completedStatuses.includes(status)) {
        completedAtClause = ", COMPLETED_AT = :completedAt";
        binds.completedAt = new Date();
      } else {
        completedAtClause = ", COMPLETED_AT = NULL";
      }

      await connection.execute(
        `
        UPDATE LIVE_ISSUE_COMPONENTS
        SET STATUS = :status,
            UPDATED_AT = :updatedAt
            ${completedAtClause}
        WHERE LIVE_ISSUE_COMPONENT_ID = :id
        `,
        binds,
        { autoCommit: false }
      );

      // -------------------------------------------------------------------------
      // STEP 5️⃣ — Auto-log or rollback worklogs
      // -------------------------------------------------------------------------
      if (completedStatuses.includes(status)) {
        const logResult = await connection.execute(
          `
          SELECT NVL(SUM(HOURS_LOGGED), 0) AS LOGGEDHOURS
          FROM COMPONENT_WORKLOGS
          WHERE TASK_COMPONENT_ID = :componentId
          `,
          { componentId: comp.LIVE_ISSUE_COMPONENT_ID },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        const loggedHours = logResult.rows[0]?.LOGGEDHOURS || 0;
        const remainingHours = comp.TOTAL_COMP_HOURS - loggedHours;

        if (remainingHours > 0) {
          await connection.execute(
            `
            INSERT INTO COMPONENT_WORKLOGS
              (EMPLOYEE_ID, TASK_COMPONENT_ID, HOURS_LOGGED, LOG_DATE)
            VALUES
              (:employeeId, :componentId, :hours, SYSDATE)
            `,
            {
              employeeId: comp.ASSIGNED_EMPLOYEE_ID,
              componentId: comp.LIVE_ISSUE_COMPONENT_ID,
              hours: remainingHours,
            },
            { autoCommit: false }
          );
        }
      } else {
        // revert → delete worklogs
        await connection.execute(
          `
          DELETE FROM COMPONENT_WORKLOGS
          WHERE TASK_COMPONENT_ID = :componentId
          `,
          { componentId: comp.LIVE_ISSUE_COMPONENT_ID },
          { autoCommit: false }
        );
      }

      // -------------------------------------------------------------------------
      // STEP 6️⃣ — Recompute LIVE ISSUE status
      // -------------------------------------------------------------------------
      const compsResult = await connection.execute(
        `
        SELECT STATUS, COMPLETED_AT
        FROM LIVE_ISSUE_COMPONENTS
        WHERE LIVE_ISSUE_ID = :liveIssueId
        `,
        { liveIssueId: comp.LIVE_ISSUE_ID },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const rows = compsResult.rows || [];
      let issueStatus = "Pending";
      let issueCompletedAt = null;

      const wipStatuses = [
        "Under_Development",
        "Under_QA",
        "Under_UAT",
        "Under_Preprod",
      ];

      if (rows.length) {
        const allCompleted = rows.every((r) =>
          completedStatuses.includes(r.STATUS)
        );
        const anyWip = rows.some((r) => wipStatuses.includes(r.STATUS));
        const anyHold = rows.some((r) => r.STATUS === "Hold");
        const allDropped = rows.every((r) => r.STATUS === "Dropped");

        if (allCompleted) {
          issueStatus = "Completed";
          issueCompletedAt =
            rows
              .map((r) => r.COMPLETED_AT)
              .filter(Boolean)
              .sort((a, b) => new Date(b) - new Date(a))[0] || new Date();
        } else if (anyWip) {
          issueStatus = "WIP";
        } else if (anyHold) {
          issueStatus = "Hold";
        } else if (allDropped) {
          issueStatus = "Dropped";
        } else {
          issueStatus = "Pending";
        }
      }

      if (issueStatus !== "Completed") issueCompletedAt = null;

      await connection.execute(
        `
        UPDATE LIVE_ISSUES
        SET STATUS = :status,
            COMPLETED_AT = :completedAt,
            UPDATED_AT = SYSTIMESTAMP
        WHERE ID = :liveIssueId
        `,
        {
          status: issueStatus,
          completedAt: issueCompletedAt,
          liveIssueId: comp.LIVE_ISSUE_ID,
        },
        { autoCommit: false }
      );

      await connection.commit();

      // -------------------------------------------------------------------------
      // STEP 7️⃣ — Fetch updated live issue
      // -------------------------------------------------------------------------
      const updatedIssue = await connection.execute(
        `
        SELECT
          li.*,
          e.NAME AS EMPLOYEE_NAME,
          e.DESIGNATION AS EMPLOYEE_DESIGNATION
        FROM LIVE_ISSUES li
        JOIN EMPLOYEES e ON li.ASSIGNED_EMPLOYEE_ID = e.ID
        WHERE li.ID = :id
        `,
        { id: comp.LIVE_ISSUE_ID },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      return res.json(updatedIssue.rows?.[0] || { message: "Status updated" });
    });
  }
);

//route to delete the live issues
router.delete(
  "/:id",
  authMiddleware(["admin", "manager", "lt", "alt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {
      const user = req.user;
const liveIssueId = Number(req.params.id);

if (!Number.isInteger(liveIssueId)) {
  return res.status(400).json({
    error: "Invalid liveIssueId. Must be a valid number.",
    received: req.params.id,
  });
}

      // -------------------------------------------------------------------------
      // STEP 1️⃣ — Fetch live issue with employee hierarchy
      // -------------------------------------------------------------------------
      const result = await connection.execute(
        `
        SELECT 
          li.ID,
          li.ASSIGNED_EMPLOYEE_ID,
          e.MANAGER_ID,
          e.REPORTING_MANAGER,
          e.ROLE
        FROM LIVE_ISSUES li
        LEFT JOIN EMPLOYEES e ON li.ASSIGNED_EMPLOYEE_ID = e.ID
        WHERE li.ID = :liveIssueId
        `,
        { liveIssueId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: "Live issue not found" });
      }

      const issue = result.rows[0];

      // -------------------------------------------------------------------------
      // STEP 2️⃣ — Role-based permission validation
      // -------------------------------------------------------------------------
      const isOwner =
        issue.ASSIGNED_EMPLOYEE_ID?.toString() === user.id?.toString();

      const isManager =
        issue.MANAGER_ID?.toString() === user.id?.toString();

      const isAdminManager =
        issue.MANAGER_ID?.toString() === user.managerId?.toString();

      if (user.role === "manager" && !isManager && !isOwner) {
        return res.status(403).json({ error: "Access denied" });
      }

      if (user.role === "admin" && !isAdminManager) {
        return res.status(403).json({ error: "Access denied" });
      }

      // -------------------------------------------------------------------------
      // STEP 3️⃣ — Begin transaction
      // -------------------------------------------------------------------------
      await connection.execute("SAVEPOINT before_live_issue_delete");

      // -------------------------------------------------------------------------
      // STEP 4️⃣ — Delete related data (correct order)
      // -------------------------------------------------------------------------

      // 🟢 Delete Worklogs (shared table)
      await connection.execute(
        `
        DELETE FROM COMPONENT_WORKLOGS
        WHERE TASK_COMPONENT_ID IN (
          SELECT LIVE_ISSUE_COMPONENT_ID
          FROM LIVE_ISSUE_COMPONENTS
          WHERE LIVE_ISSUE_ID = :liveIssueId
        )
        `,
        { liveIssueId }
      );

      // 🟡 Delete Live Issue Components
      await connection.execute(
        `
        DELETE FROM LIVE_ISSUE_COMPONENTS
        WHERE LIVE_ISSUE_ID = :liveIssueId
        `,
        { liveIssueId }
      );

      // 🔴 Delete Live Issue
      const deleteResult = await connection.execute(
        `
        DELETE FROM LIVE_ISSUES
        WHERE ID = :liveIssueId
        `,
        { liveIssueId }
      );

      if (deleteResult.rowsAffected === 0) {
        await connection.rollback();
        return res
          .status(404)
          .json({ error: "Live issue not found or already deleted" });
      }

      // -------------------------------------------------------------------------
      // STEP 5️⃣ — Commit
      // -------------------------------------------------------------------------
      await connection.commit();

      // -------------------------------------------------------------------------
      // ✅ STEP 6️⃣ — Final response
      // -------------------------------------------------------------------------
      res.json({
        message: "Live issue and all related records deleted successfully",
        liveIssueId,
      });
    });
  }
);

// POST /api/tasks/components/:id/log --> create a new worklog for a task for an employee
router.post(
  "/components/:id/log",
  authMiddleware(["employee", "manager", "admin","alt", "lt", "head_lt"]),async (req, res) => {
    return safeRoute(req, res, async (connection) => {
   
      const componentId = Number(req.params.id);
      const user = req.user;
      const { hoursLogged, logDate, notes } = req.body; // Example: { hoursLogged: 4, logDate: '2025-11-08' }

      // Basic input validation
      if (!hoursLogged || hoursLogged <= 0 || !logDate) {
        return res.status(400).json({ error: "Hours logged and log date are required." });
      }


      // -------------------------------------------------------------------------
      // STEP 1️⃣ — Fetch component and related employee details
      // -------------------------------------------------------------------------
      const compQuery = `
        SELECT 
          c.LIVE_ISSUE_COMPONENT_ID, 
          c.TOTAL_COMP_HOURS, 
          c.STATUS, 
          c.LIVE_ISSUE_ID, 
          t.ASSIGNED_EMPLOYEE_ID AS EMPLOYEE_ID,
          e.MANAGER_ID,
          e.REPORTING_MANAGER
        FROM LIVE_ISSUE_COMPONENTS c
        JOIN LIVE_ISSUES t ON c.LIVE_ISSUE_ID = t.ID
        JOIN EMPLOYEES e ON t.ASSIGNED_EMPLOYEE_ID = e.ID
        WHERE c.LIVE_ISSUE_COMPONENT_ID = :componentId
      `;
      const compResult = await connection.execute(compQuery, { componentId }, { outFormat: oracledb.OUT_FORMAT_OBJECT });

      if (compResult.rows.length === 0)
        return res.status(404).json({ error: "Component not found." });

      const component = compResult.rows[0];

      // -------------------------------------------------------------------------
      // STEP 2️⃣ — Role-based permission validation
      // -------------------------------------------------------------------------
      let allowed = false;

      if (user.role === "employee") {
        allowed = Number(component.EMPLOYEE_ID) === Number(user.id);
      } else if (user.role === "manager") {
        allowed =
          Number(component.MANAGER_ID) === Number(user.id) ||
          Number(component.EMPLOYEE_ID) === Number(user.id);
      } else if (user.role === "admin") {
        allowed =
          Number(component.REPORTING_MANAGER) === Number(user.id) ||
          Number(component.EMPLOYEE_ID) === Number(user.id);
      } else if (["alt","lt", "head_lt"].includes(user.role.toLowerCase())) {
        const { sqlCondition, binds } = buildVisibilityOracle(user, {});
        const checkQuery = `
          SELECT 1 
          FROM EMPLOYEES e 
          WHERE e.ID = :empId ${sqlCondition ? sqlCondition.replace(/^ AND /, " AND ") : ""}
        `;
        const checkRes = await connection.execute(checkQuery, { ...binds, empId: component.EMPLOYEE_ID });
        allowed = checkRes.rows.length > 0;
      }

      if (!allowed) {
        return res.status(403).json({ error: "Access denied. You are not authorized to log hours for this component." });
      }

      // -------------------------------------------------------------------------
      // STEP 3️⃣ — Validate no over-logging
      // -------------------------------------------------------------------------
      const loggedResult = await connection.execute(
        `SELECT NVL(SUM(HOURS_LOGGED), 0) AS TOTAL_LOGGED 
         FROM COMPONENT_WORKLOGS 
         WHERE TASK_COMPONENT_ID = :componentId`,
        { componentId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const totalLogged = loggedResult.rows[0].TOTAL_LOGGED || 0;
      const remaining = Number(component.TOTAL_COMP_HOURS) - totalLogged;

      if (hoursLogged > remaining) {
        return res.status(400).json({ error: `Cannot log more than remaining ${remaining} hours.` });
      }

      // -------------------------------------------------------------------------
      // STEP 4️⃣ — Insert new worklog
      // -------------------------------------------------------------------------
      await connection.execute(
        `INSERT INTO COMPONENT_WORKLOGS 
          (TASK_COMPONENT_ID, EMPLOYEE_ID, HOURS_LOGGED, LOG_DATE, NOTES)
         VALUES 
          (:componentId, :userId, :hoursLogged, TO_DATE(:logDate, 'YYYY-MM-DD'), :notes)`,
        { componentId, userId: user.id, hoursLogged, logDate, notes },
        { autoCommit: false }
      );

      // -------------------------------------------------------------------------
      // STEP 5️⃣ — Auto-complete component if fully logged
      // -------------------------------------------------------------------------
      const newTotal = totalLogged + Number(hoursLogged);
      if (newTotal >= Number(component.TOTAL_COMP_HOURS)) {
        await connection.execute(
          `UPDATE LIVE_ISSUE_COMPONENTS
           SET STATUS = 'Live', COMPLETED_AT = SYSTIMESTAMP
           WHERE LIVE_ISSUE_COMPONENT_ID = :componentId`,
          { componentId },
          { autoCommit: false }
        );

        // Check if all components of the task are complete
        const allCompStatus = await connection.execute(
          `SELECT COUNT(*) AS TOTAL, 
                  SUM(CASE WHEN STATUS = 'Live' THEN 1 ELSE 0 END) AS COMPLETED
           FROM LIVE_ISSUE_COMPONENTS
           WHERE LIVE_ISSUE_ID = :taskId`,
          { taskId: component.TASK_ID },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        const total = allCompStatus.rows[0].TOTAL;
        const completed = allCompStatus.rows[0].COMPLETED;

        if (total > 0 && total === completed) {
          await connection.execute(
            `UPDATE LIVE_ISSUES 
             SET STATUS = 'Completed', COMPLETED_AT = SYSTIMESTAMP 
             WHERE TASK_ID = :taskId`,
            { taskId: component.TASK_ID },
            { autoCommit: false }
          );
        }
      }

      await connection.commit();
      res.status(201).json({ message: "Work logged successfully." });

    });
});

// GET --> fetch all logs of the employee for a task component
router.get(
  "/components/:id/logs",
  authMiddleware(["employee", "admin", "manager","lt","alt","head_lt"]),async (req, res) => {
      return safeRoute(req, res, async (connection) => {

      const componentId = req.params.id;

      const result = await connection.execute(
        `SELECT wl.WORKLOG_ID,
                wl.HOURS_LOGGED,
                TO_CHAR(wl.LOG_DATE, 'YYYY-MM-DD') AS LOG_DATE,
                wl.NOTES,
                e.NAME AS EMPLOYEE_NAME
         FROM COMPONENT_WORKLOGS wl
         JOIN EMPLOYEES e ON wl.EMPLOYEE_ID = e.ID
         WHERE wl.TASK_COMPONENT_ID = :componentId
         ORDER BY wl.LOG_DATE DESC`,
        { componentId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const formattedLogs = formatLogsDates(result.rows);
      res.json(formattedLogs);

   
  });
});

// 🗓️ Helper to format date like "21-Oct-2025"
function formatDateForDisplay(date) {
  if (!date) return null;
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, "0");
  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ];
  const month = monthNames[d.getMonth()];
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

// 🧾 Format an array of work logs
function formatLogsDates(logs) {
  return logs.map(log => ({
    ...log,
    LOG_DATE: formatDateForDisplay(log.LOG_DATE)
  }));
}

//update a log for an employee for a task component
router.put(
  "/components/log/:logId",
  authMiddleware(["employee", "admin", "manager", "lt", "alt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {
      const logId = Number(req.params.logId);
      const { hoursLogged, logDate, notes } = req.body;
      const userId = req.user.id;

      if (hoursLogged === undefined || !logDate) {
        return res.status(400).json({ error: "Hours and log date required" });
      }

      // ------------------------------------------------------------------
      // 1️⃣ Fetch log + component + task
      // ------------------------------------------------------------------
      const logRes = await connection.execute(
        `
        SELECT
          wl.WORKLOG_ID,
          wl.TASK_COMPONENT_ID,
          wl.HOURS_LOGGED AS OLD_HOURS,
          c.TOTAL_COMP_HOURS,
          c.STATUS AS COMPONENT_STATUS,
          t.ID,
          t.STATUS AS TASK_STATUS,
          t.ASSIGNED_EMPLOYEE_ID AS E_ID
        FROM COMPONENT_WORKLOGS wl
        JOIN LIVE_ISSUE_COMPONENTS c ON wl.TASK_COMPONENT_ID = c.LIVE_ISSUE_COMPONENT_ID
        JOIN LIVE_ISSUES t ON c.LIVE_ISSUE_ID = t.ID
        WHERE wl.WORKLOG_ID = :logId
        `,
        { logId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      if (!logRes.rows.length)
        return res.status(404).json({ error: "Log not found" });

      const log = logRes.rows[0];

      if (Number(log.E_ID) !== Number(userId))
        return res.status(403).json({ error: "Unauthorized" });

      // ------------------------------------------------------------------
      // 2️⃣ Lock completed components
      // ------------------------------------------------------------------
      if (log.COMPONENT_STATUS === "Completed") {
        return res.status(400).json({
          error:
            "This component is already completed. Logs cannot be edited.",
        });
      }

      // ------------------------------------------------------------------
      // 3️⃣ Calculate remaining hours safely
      // ------------------------------------------------------------------
      const sumRes = await connection.execute(
        `
        SELECT NVL(SUM(HOURS_LOGGED),0) AS TOTAL
        FROM COMPONENT_WORKLOGS
        WHERE TASK_COMPONENT_ID = :cid
          AND WORKLOG_ID != :logId
        `,
        {
          cid: log.TASK_COMPONENT_ID,
          logId,
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const alreadyLogged = sumRes.rows[0].TOTAL || 0;
      const remaining = log.TOTAL_COMP_HOURS - alreadyLogged;

      // ❌ Cannot exceed remaining
      if (hoursLogged > remaining) {
        return res.status(400).json({
          error: `Only ${remaining} hours remaining. Mark component as Completed to finish.`,
        });
      }

      // ❌ Cannot exactly finish via edit
      if (hoursLogged === remaining) {
        return res.status(400).json({
          error:
            "You cannot complete a component via log edit. Use the status dropdown to mark it Completed.",
        });
      }

      // ------------------------------------------------------------------
      // 4️⃣ Update log
      // ------------------------------------------------------------------
      await connection.execute(
        `
        UPDATE COMPONENT_WORKLOGS
        SET
          HOURS_LOGGED = :hours,
          LOG_DATE = TO_DATE(:logDate,'YYYY-MM-DD'),
          NOTES = :notes
        WHERE WORKLOG_ID = :logId
        `,
        {
          hours: hoursLogged,
          logDate,
          notes,
          logId,
        }
      );

      // ------------------------------------------------------------------
      // 5️⃣ Recalculate component & task status
      // ------------------------------------------------------------------

      // Component status
      let newCompStatus = "Pending";
      if (alreadyLogged + hoursLogged > 0) newCompStatus = "Under_Development";

      await connection.execute(
        `
        UPDATE LIVE_ISSUE_COMPONENTS
        SET STATUS = :status
        WHERE LIVE_ISSUE_COMPONENT_ID = :cid
        `,
        {
          status: newCompStatus,
          cid: log.LIVE_ISSUE_COMPONENT_ID,
        }
      );

      // Task status recalculation
      const taskCompRes = await connection.execute(
        `
        SELECT STATUS FROM LIVE_ISSUE_COMPONENTS
        WHERE LIVE_ISSUE_ID = :taskId
        `,
        { taskId: log.LIVE_ISSUE_ID },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const statuses = taskCompRes.rows.map(r => r.STATUS);
      let taskStatus = "Pending";

      if (statuses.every(s => s === "Completed")) taskStatus = "Completed";
      else if (statuses.some(s => s !== "Pending")) taskStatus = "Under_Development";

      await connection.execute(
        `
        UPDATE LIVE_ISSUES
        SET STATUS = :status
        WHERE ID = :taskId
        `,
        {
          status: taskStatus,
          taskId: log.LIVE_ISSUE_ID,
        }
      );

      await connection.commit();

      res.json({ message: "Worklog updated successfully." });
    });
  }
);

//delete a log for an employee for a task component
// Delete a worklog and recalculate component + task status
router.delete(
  "/components/log/:logId",
  authMiddleware(["employee", "admin", "manager", "lt", "alt", "head_lt"]),
  async (req, res) => {
    return safeRoute(req, res, async (connection) => {
      const logId = Number(req.params.logId);
      const userId = req.user.id;

      // ------------------------------------------------------------------
      // 1️⃣ Fetch ownership + component + task info
      // ------------------------------------------------------------------
      const logRes = await connection.execute(
        `
        SELECT
          wl.TASK_COMPONENT_ID,
          c.LIVE_ISSUE_COMPONENT_ID,
          c.LIVE_ISSUE_ID,
          c.TOTAL_COMP_HOURS,
          t.ASSIGNED_EMPLOYEE_ID AS E_ID
        FROM COMPONENT_WORKLOGS wl
        JOIN LIVE_ISSUE_COMPONENTS c
          ON wl.TASK_COMPONENT_ID = c.LIVE_ISSUE_COMPONENT_ID
        JOIN LIVE_ISSUES t
          ON c.LIVE_ISSUE_ID = t.ID
        WHERE wl.WORKLOG_ID = :logId
        `,
        { logId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      if (!logRes.rows.length)
        return res.status(404).json({ error: "Log not found" });

      const log = logRes.rows[0];

      if (Number(log.E_ID) !== Number(userId))
        return res.status(403).json({ error: "Unauthorized" });

      // ------------------------------------------------------------------
      // 2️⃣ Delete worklog
      // ------------------------------------------------------------------
      await connection.execute(
        `DELETE FROM COMPONENT_WORKLOGS WHERE WORKLOG_ID = :logId`,
        { logId }
      );

      // ------------------------------------------------------------------
      // 3️⃣ Recalculate component logged hours
      // ------------------------------------------------------------------
      const sumRes = await connection.execute(
        `
        SELECT NVL(SUM(HOURS_LOGGED),0) AS TOTAL
        FROM COMPONENT_WORKLOGS
        WHERE TASK_COMPONENT_ID = :cid
        `,
        { cid: log.TASK_COMPONENT_ID },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const totalLogged = sumRes.rows[0].TOTAL || 0;

      // ------------------------------------------------------------------
      // 4️⃣ Update component status
      // ------------------------------------------------------------------
      let componentStatus = "Pending";

      if (totalLogged > 0 && totalLogged < log.TOTAL_COMP_HOURS)
        componentStatus = "WIP";
      else if (totalLogged === log.TOTAL_COMP_HOURS)
        componentStatus = "Completed";

      await connection.execute(
        `
        UPDATE LIVE_ISSUE_COMPONENTS
        SET STATUS = :status
        WHERE LIVE_ISSUE_COMPONENT_ID = :cid
        `,
        {
          status: componentStatus,
          cid: log.LIVE_ISSUE_COMPONENT_ID,
        }
      );

      // ------------------------------------------------------------------
      // 5️⃣ Recalculate task status
      // ------------------------------------------------------------------
      const taskCompRes = await connection.execute(
        `
        SELECT STATUS
        FROM LIVE_ISSUE_COMPONENTS
        WHERE LIVE_ISSUE_ID = :taskId
        `,
        { taskId: log.LIVE_ISSUE_ID },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const statuses = taskCompRes.rows.map(r => r.STATUS);
      let taskStatus = "Pending";

      if (statuses.every(s => s === "Completed"))
        taskStatus = "Completed";
      else if (statuses.some(s => s !== "Pending"))
        taskStatus = "WIP";

      await connection.execute(
        `
        UPDATE LIVE_ISSUES
        SET STATUS = :status
        WHERE ID = :taskId
        `,
        {
          status: taskStatus,
          taskId: log.LIVE_ISSUE_ID,
        }
      );

      // ------------------------------------------------------------------
      // 6️⃣ Commit
      // ------------------------------------------------------------------
      await connection.commit();

      res.json({ message: "Worklog deleted and statuses updated successfully." });
    });
  }
);



module.exports = router;