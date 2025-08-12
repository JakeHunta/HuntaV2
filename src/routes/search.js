const express = require('express');
const router = express.Router();
const { search } = require('../services/searchService');

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const out = await search(body);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
