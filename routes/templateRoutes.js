const express = require('express');
const router = express.Router();
const { getTemplate, saveTemplate } = require('../controllers/templateController');
const { protect } = require('../middleware/authMiddleware');

router.get('/:name', protect, getTemplate);
router.post('/', protect, saveTemplate);

module.exports = router;
