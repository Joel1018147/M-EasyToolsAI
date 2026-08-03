'use strict';

const { Pool, types } = require('pg');

// NUMERIC/DECIMAL (OID 1700) comes back from node-postgres as a string by
// default. Registered globally, once: every NUMERIC/DECIMAL column read
// anywhere in this app is a JS number without needing parseFloat() at
// every call site.
//
// Guarded: some test harnesses swap `require('pg')` for a pg-mem shim
// that doesn't export `types` at all. Without the guard, requiring this
// module crashes under that harness before a single assertion runs.
if (types && typeof types.setTypeParser === 'function') {
  types.setTypeParser(1700, parseFloat);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

module.exports = { pool };
