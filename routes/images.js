/* ═══════════════════════════════════════════════════════════════════════════
   Image generation — LANE D
   ───────────────────────────────────────────────────────────────────────────
   FOUNDATION STUB. Mounted by server.js so that Lane D never has to edit
   server.js — that is the whole reason this file exists this early. After
   Foundation, no lane touches the entry point, which is what lets the lanes
   run genuinely in parallel over disjoint files.

   RULE 6: this does not pretend. Every route answers 501 with a body that
   says the lane has not landed, rather than returning an empty list or a
   zeroed object that a caller would read as a real, working answer.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const express = require('express');
const router = express.Router();

router.use((req, res) => {
  res.status(501).json({
    ok: false,
    reason: 'not_implemented',
    message: 'Image generation is not built yet (Round 1, Lane D). This route is a ' +
             'mounted placeholder, not a working endpoint.',
  });
});

module.exports = router;
