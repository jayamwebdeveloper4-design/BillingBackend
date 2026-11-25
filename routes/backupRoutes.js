const express = require('express');
const router = express.Router();
const fs = require('fs');
const multer = require('multer');
const { protect } = require('../middleware/authMiddleware');
const {
  exportFullDatabase,
  importFullDatabase,
  listServerBackups,
  resolveBackupFile,
  getTimestampString,
  BACKUP_DIR
} = require('../DB_Backup/BackupAndReStore');

// Configure Multer for JSON file uploads (up to 50MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/json' || file.originalname.endsWith('.json')) {
      cb(null, true);
    } else {
      cb(new Error('Only .json backup files are allowed!'), false);
    }
  }
});

/**
 * Shared Helper: Safely parses JSON from an uploaded Multer file
 */
const parseUploadedJsonFile = (req) => {
  if (!req.file || !req.file.buffer) {
    const error = new Error('Please upload a valid .json backup file.');
    error.status = 400;
    throw error;
  }
  try {
    return JSON.parse(req.file.buffer.toString('utf-8'));
  } catch (parseErr) {
    const error = new Error('Invalid JSON file format. Could not parse file.');
    error.status = 400;
    throw error;
  }
};

/**
 * @route   GET /api/backup/download
 * @desc    Export and download full database backup directly
 * @access  Private (Admin)
 */
router.get('/download', protect, async (req, res) => {
  try {
    const backupResult = await exportFullDatabase();
    const cleanFilename = `JayamBilling_Backup_${getTimestampString()}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${cleanFilename}"`);
    return res.status(200).json(backupResult.data);
  } catch (error) {
    console.error('Error downloading database backup:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to generate database backup',
      error: error.message
    });
  }
});

/**
 * @route   POST /api/backup/create
 * @desc    Generate a fresh backup snapshot in the server backup folder
 * @access  Private (Admin)
 */
router.post('/create', protect, async (req, res) => {
  try {
    const result = await exportFullDatabase();
    return res.status(201).json({
      success: true,
      message: 'Database backup created successfully',
      filename: result.filename,
      fileSize: result.fileSizeFormatted,
      exportedAt: result.exportedAt,
      stats: result.stats
    });
  } catch (error) {
    console.error('Error creating database backup:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create backup',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/backup/list
 * @desc    List all server-stored backup files
 * @access  Private (Admin)
 */
router.get('/list', protect, async (req, res) => {
  try {
    const backups = listServerBackups();
    return res.status(200).json({
      success: true,
      count: backups.length,
      backups
    });
  } catch (error) {
    console.error('Error listing backups:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to list backups',
      error: error.message
    });
  }
});

/**
 * @route   POST /api/backup/restore-upload
 * @desc    Upload an external .json backup file and restore database
 * @access  Private (Admin)
 */
router.post('/restore-upload', protect, upload.single('backupFile'), async (req, res) => {
  try {
    const parsedData = parseUploadedJsonFile(req);
    const restoreResult = await importFullDatabase(parsedData);

    return res.status(200).json({
      success: true,
      message: 'Database restored successfully from uploaded file',
      restoredCounts: restoreResult.restoredCounts
    });
  } catch (error) {
    console.error('Error restoring database from upload:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Restoration failed'
    });
  }
});

/**
 * @route   POST /api/backup/restore-file
 * @desc    Restore database from an existing file on the server
 * @access  Private (Admin)
 */
router.post('/restore-file', protect, async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) {
      return res.status(400).json({
        success: false,
        message: 'Filename is required'
      });
    }

    const fileInfo = resolveBackupFile(filename);
    if (!fileInfo || !fileInfo.exists) {
      return res.status(404).json({
        success: false,
        message: `Backup file "${fileInfo?.safeFilename || filename}" not found on server`
      });
    }

    const rawData = fs.readFileSync(fileInfo.targetPath, 'utf-8');
    const parsedData = JSON.parse(rawData);

    const restoreResult = await importFullDatabase(parsedData);
    return res.status(200).json({
      success: true,
      message: `Database restored successfully from ${fileInfo.safeFilename}`,
      restoredCounts: restoreResult.restoredCounts
    });
  } catch (error) {
    console.error('Error restoring database from file:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Restoration failed'
    });
  }
});

/**
 * @route   GET /api/backup/download-file/:filename
 * @desc    Download a specific backup file from the server
 * @access  Private (Admin)
 */
router.get('/download-file/:filename', protect, async (req, res) => {
  try {
    const fileInfo = resolveBackupFile(req.params.filename);
    if (!fileInfo || !fileInfo.exists) {
      return res.status(404).json({
        success: false,
        message: `Backup file "${fileInfo?.safeFilename || req.params.filename}" not found on server`
      });
    }

    return res.download(fileInfo.targetPath, fileInfo.safeFilename);
  } catch (error) {
    console.error('Error downloading server backup file:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to download file',
      error: error.message
    });
  }
});

/**
 * @route   POST /api/backup/upload
 * @desc    Upload an external backup file and save it into the server backup folder
 * @access  Private (Admin)
 */
router.post('/upload', protect, upload.single('backupFile'), async (req, res) => {
  try {
    const parsedData = parseUploadedJsonFile(req);

    // Generate safe unique filename for storage
    const originalName = req.file.originalname.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const safeFilename = `uploaded_${getTimestampString()}_${originalName}`;
    const fileInfo = resolveBackupFile(safeFilename);

    // Save compact JSON into backup repository
    fs.writeFileSync(fileInfo.targetPath, JSON.stringify(parsedData), 'utf-8');

    return res.status(201).json({
      success: true,
      message: 'Backup file uploaded and saved to server successfully',
      filename: safeFilename
    });
  } catch (error) {
    console.error('Error uploading backup file to server:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Upload failed'
    });
  }
});

/**
 * @route   DELETE /api/backup/delete-file/:filename
 * @desc    Delete a specific backup file from the server
 * @access  Private (Admin)
 */
router.delete('/delete-file/:filename', protect, async (req, res) => {
  try {
    const fileInfo = resolveBackupFile(req.params.filename);
    if (!fileInfo || !fileInfo.exists) {
      return res.status(404).json({
        success: false,
        message: `Backup file "${fileInfo?.safeFilename || req.params.filename}" not found on server`
      });
    }

    fs.unlinkSync(fileInfo.targetPath);
    return res.status(200).json({
      success: true,
      message: `Backup file "${fileInfo.safeFilename}" deleted successfully`
    });
  } catch (error) {
    console.error('Error deleting server backup file:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Delete failed'
    });
  }
});

module.exports = router;
