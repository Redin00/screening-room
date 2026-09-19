const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { nanoid } = require('nanoid');
const config = require('./config');
const { roomDir } = require('./cleanup/scheduler');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = roomDir(req.room.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${nanoid(12)}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  const extOk = config.allowedExtensions.includes(ext);
  const mimeOk = config.allowedMimePrefixes.some((p) => file.mimetype.startsWith(p));

  if (!extOk || !mimeOk) {
    return cb(new Error('Only video files are allowed (mp4, webm, mov, mkv, avi, ogg, m4v).'));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.maxUploadMb * 1024 * 1024,
    files: 1,
  },
});

module.exports = upload;
