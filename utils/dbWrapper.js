const oracledb = require("oracledb");

let connectionCounter = 0;

// ====== PATCH 1: Patch plain oracledb.getConnection() ======
const originalGetConnection = oracledb.getConnection;
oracledb.getConnection = async function (...args) {
  const conn = await originalGetConnection.apply(this, args);

  conn.__cid = ++connectionCounter;
  console.log(`[OPEN CONN] ${conn.__cid} (direct)`);

  return conn;
};


// ====== PATCH 2: Patch pool.getConnection() ======
const originalPoolGetConnection = oracledb.Pool.prototype.getConnection;
oracledb.Pool.prototype.getConnection = async function (...args) {
  const conn = await originalPoolGetConnection.apply(this, args);

  conn.__cid = ++connectionCounter;
  console.log(`[OPEN CONN] ${conn.__cid} (pool)`);

  return conn;
};


// ====== PATCH 3: Patch close() ======
const originalClose = oracledb.Connection.prototype.close;
oracledb.Connection.prototype.close = async function (...args) {
  console.log(`[CLOSE CONN] ${this.__cid}`);
  return originalClose.apply(this, args);
};


/**
 * Safe wrapper for a database route
 * ALWAYS closes the connection
 * NEVER leaks connections even on:
 *   - validation errors
 *   - throw
 *   - early return
 *   - SQL errors
 *
 * Usage:
 *    db.safeRoute(req, res, async (conn) => {
 *        const r = await conn.execute(...)
 *        res.json(r)
 *    })
 */
async function safeRoute(req, res, handler) {
  let conn;

  try {
    conn = await oracledb.getPool().getConnection();

    return await handler(conn);

  } catch (err) {
    console.error("❌ Route error:", err);
    if (!res.headersSent) res.status(500).json({ error: err.message });

  } finally {
    if (conn) {
      try {
        console.log(`[CLOSE CONN] ${conn._connectionId}`);
        await conn.close();
      } catch (e) {
        console.error("❌ Error closing:", e);
      }
    }
  }
}


module.exports = { safeRoute };
