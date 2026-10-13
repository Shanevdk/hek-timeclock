// Object storage for file attachments.
//
// Why this exists: attachments used to be base64'd into a JSON request and kept
// inside the MongoDB document. That caps out three ways — Netlify Functions
// refuse a request over ~6 MB and a response over 6 MB (see FN_RESPONSE_MAX in
// server.js), and a MongoDB document can never exceed 16 MB. A 1 GB file fits
// none of those.
//
// So the bytes never touch the app any more. The browser uploads straight to
// object storage with presigned part URLs, and downloads are a redirect to a
// short-lived presigned GET. MongoDB keeps only the metadata and the key. The
// app's job is to decide *who* may have a URL, then sign one.
//
// Three drivers:
//
//   s3    — any S3-compatible bucket (Cloudflare R2 by default, but AWS S3,
//           Backblaze B2 and Supabase Storage all work by changing S3_ENDPOINT).
//           The one to use in production: it is what lifts the cap to 1 GB.
//   db    — the bytes in MongoDB, in small chunks, through signed app routes.
//           What a deployed site falls back to when no bucket is configured, so
//           attachments keep working there — capped at the few MB a serverless
//           function can carry in one response.
//   local — files on disk, served back through signed app routes. Used when no
//           bucket is configured so `npm start` works on a laptop with no cloud
//           account. Never used on a read-only serverless filesystem.
//
// All three expose the same small interface, so server.js never branches on
// driver:
//
//   createUpload({ key, contentType, size })  -> { uploadId, partSize, parts[] }
//   completeUpload({ key, uploadId, parts })  -> { etag }
//   abortUpload({ key, uploadId })
//   head({ key })                             -> { size, contentType } | null
//   presignGet({ key, filename, download })   -> URL string
//   remove({ key })

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

// The ceiling the product promises. Checked before an upload is authorised, and
// again against the real object size once it lands.
const MAX_UPLOAD_BYTES = Number(process.env.ATTACH_MAX_BYTES || 1024 * 1024 * 1024);

// Multipart part size. 10 MB keeps a dropped mobile connection cheap to retry
// while staying above S3's 5 MB minimum for non-final parts. Bigger files scale
// the part size up rather than exceed the 10,000-part limit.
const MIN_PART = 10 * 1024 * 1024;
const MAX_PARTS = 9000; // under the 10,000 hard limit, with room to spare
const partSizeFor = (size) => Math.max(MIN_PART, Math.ceil(size / MAX_PARTS));

// How long a signed URL lives. Upload URLs have to outlast a slow phone pushing
// a gigabyte; download URLs are handed out one request at a time, so they can be
// short — the window in which a leaked link is useful.
const PUT_TTL = 6 * 60 * 60; // 6 hours
const GET_TTL = 5 * 60; // 5 minutes

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Object keys are built by us, never taken from the client, so a filename can't
// climb out of its prefix. The original name is kept in MongoDB for display and
// re-attached at download time via Content-Disposition.
function buildKey(prefix, id, filename) {
  const ext = path.extname(String(filename || '')).slice(0, 12).replace(/[^\w.]/g, '');
  return `${prefix}/${id}${ext}`;
}

// Content-Disposition with a filename that is safe in both the quoted form and
// the RFC 5987 form, so non-ASCII names survive on phones.
function disposition(filename, download) {
  const name = String(filename || 'file').replace(/["\\\r\n]/g, '');
  const kind = download ? 'attachment' : 'inline';
  return `${kind}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// Signed tokens for the app-served drivers (db and local). They stand in for a
// presigned URL's signature: each names exactly one operation and expires.
function tokenSigner(secret) {
  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }
  function verify(token) {
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) return null;
    const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    // Constant-time compare: a token check that leaks timing is a token check
    // that can be brute-forced one byte at a time.
    const a = Buffer.from(mac);
    const b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch (err) {
      return null;
    }
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    return payload;
  }
  return { sign, verify };
}

// An error whose message is written for the person who hit it, carried to the
// browser as-is instead of being flattened into "Server error."
function shownError(message, status) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

// ---------------------------------------------------------------------------
// S3-compatible driver
// ---------------------------------------------------------------------------

function s3Driver(cfg) {
  const {
    S3Client,
    CreateMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    UploadPartCommand,
    HeadObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
  } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint || undefined,
    // R2 and most S3-compatible providers need path-style addressing; real AWS
    // is happy either way.
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  const Bucket = cfg.bucket;

  // A refusal from the bucket (wrong key, missing bucket, bad endpoint) is a
  // setup problem the office can act on, so it says what the bucket said
  // rather than "Server error."
  const refused = (err) =>
    shownError(
      'File storage refused the upload (' +
        ((err && (err.Code || err.name)) || 'error') +
        (err && err.message ? ': ' + err.message : '') +
        '). Check the S3_* settings.',
      502
    );

  return {
    mode: 's3',

    async createUpload({ key, contentType, size }) {
      let out;
      try {
        out = await client.send(
          new CreateMultipartUploadCommand({
            Bucket,
            Key: key,
            ContentType: contentType || 'application/octet-stream',
          })
        );
      } catch (err) {
        throw refused(err);
      }
      const partSize = partSizeFor(size);
      const count = Math.max(1, Math.ceil(size / partSize));
      // Every part is signed up front: 100 URLs for a 1 GB file is one round
      // trip, and the client can then retry any single part on its own.
      const parts = [];
      for (let n = 1; n <= count; n++) {
        parts.push({
          partNumber: n,
          url: await getSignedUrl(
            client,
            new UploadPartCommand({ Bucket, Key: key, UploadId: out.UploadId, PartNumber: n }),
            { expiresIn: PUT_TTL }
          ),
        });
      }
      return { uploadId: out.UploadId, partSize, parts };
    },

    async completeUpload({ key, uploadId, parts }) {
      let out;
      try {
        out = await client.send(
          new CompleteMultipartUploadCommand({
            Bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
              Parts: parts
                .slice()
                .sort((a, b) => a.partNumber - b.partNumber)
                .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
            },
          })
        );
      } catch (err) {
        throw refused(err);
      }
      return { etag: out.ETag || null };
    },

    async abortUpload({ key, uploadId }) {
      try {
        await client.send(
          new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId })
        );
      } catch (err) {
        // An abandoned upload that was never started, or already cleaned up, is
        // not a failure worth surfacing to the person deleting the row.
      }
    },

    async head({ key }) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: Number(out.ContentLength || 0), contentType: out.ContentType || null };
      } catch (err) {
        return null;
      }
    },

    async presignGet({ key, filename, contentType, download, ttl }) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket,
          Key: key,
          // Set on the way out rather than at upload time, so the same object can
          // be viewed inline or forced to download from the same stored bytes.
          ResponseContentDisposition: disposition(filename, download),
          ResponseContentType: contentType || undefined,
        }),
        { expiresIn: ttl || GET_TTL }
      );
    },

    async remove({ key }) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
      } catch (err) {
        // Losing the row matters more than losing the blob; a missing object
        // must not block the delete.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Local-disk driver
// ---------------------------------------------------------------------------
//
// The "presigned URLs" here are app routes carrying an HMAC token, mounted by
// server.js. Same three-step shape as S3 so the client code is identical.

function localDriver(cfg) {
  const root = cfg.dir;
  const objects = path.join(root, 'objects');
  const staging = path.join(root, 'uploads');
  fs.mkdirSync(objects, { recursive: true });
  fs.mkdirSync(staging, { recursive: true });

  const objectPath = (key) => path.join(objects, key.replace(/[\\/]+/g, '__'));
  const partPath = (uploadId, n) => path.join(staging, uploadId, `part-${n}`);

  const { sign, verify } = tokenSigner(cfg.secret);

  return {
    mode: 'local',
    sign,
    verify,
    objectPath,
    partPath,

    async createUpload({ key, size }) {
      const uploadId = crypto.randomUUID();
      await fsp.mkdir(path.join(staging, uploadId), { recursive: true });
      const partSize = partSizeFor(size);
      const count = Math.max(1, Math.ceil(size / partSize));
      const exp = Math.floor(Date.now() / 1000) + PUT_TTL;
      const parts = [];
      for (let n = 1; n <= count; n++) {
        parts.push({
          partNumber: n,
          url:
            '/api/storage/local/part?token=' +
            encodeURIComponent(sign({ op: 'put', uploadId, part: n, exp })),
        });
      }
      return { uploadId, partSize, parts };
    },

    async completeUpload({ key, uploadId, parts }) {
      const ordered = parts.slice().sort((a, b) => a.partNumber - b.partNumber);
      const out = objectPath(key);
      await fsp.mkdir(path.dirname(out), { recursive: true });
      const sink = fs.createWriteStream(out);
      try {
        for (const p of ordered) {
          const buf = await fsp.readFile(partPath(uploadId, p.partNumber));
          await new Promise((res, rej) => sink.write(buf, (e) => (e ? rej(e) : res())));
        }
      } finally {
        await new Promise((res) => sink.end(res));
      }
      await fsp.rm(path.join(staging, uploadId), { recursive: true, force: true });
      return { etag: null };
    },

    async abortUpload({ uploadId }) {
      await fsp.rm(path.join(staging, uploadId), { recursive: true, force: true });
    },

    async head({ key }) {
      try {
        const st = await fsp.stat(objectPath(key));
        return { size: st.size, contentType: null };
      } catch (err) {
        return null;
      }
    },

    async presignGet({ key, filename, contentType, download, ttl }) {
      const exp = Math.floor(Date.now() / 1000) + (ttl || GET_TTL);
      return (
        '/api/storage/local/object?token=' +
        encodeURIComponent(
          sign({ op: 'get', key, filename, ct: contentType || '', download: !!download, exp })
        )
      );
    },

    async remove({ key }) {
      await fsp.rm(objectPath(key), { force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// MongoDB driver
// ---------------------------------------------------------------------------
//
// For a deployed site with no bucket. The bytes go in a `file_chunks`
// collection, one document per part, and come back out through a signed app
// route — the same three-step shape as the other two, so the browser code does
// not change.
//
// Every byte passes through a serverless function both ways here, which is
// exactly what the bucket exists to avoid: a request or response over a few MB
// is refused by the host. So parts are kept small, and the whole file is capped
// at what one function response can carry back (DB_MAX_BYTES). Configuring a
// bucket lifts it to the full 1 GB.

const DB_PART = 2 * 1024 * 1024;
// 4 MB raw is ~5.6 MB once base64'd for Netlify's 6 MB response ceiling, and
// under Vercel's 4.5 MB limit.
const DB_MAX_BYTES = 4 * 1024 * 1024;

// A stored Binary back to a Buffer. The driver hands back a Binary whose
// backing buffer can be longer than the data, so it is cut to its length.
function chunkBytes(data) {
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data.buffer) return Buffer.from(data.buffer.subarray(0, data.position ?? data.buffer.length));
  return Buffer.from(data);
}

function dbDriver(cfg) {
  const { sign, verify } = tokenSigner(cfg.secret);
  let indexed = null;
  // Resolved on first use: on a serverless host the connection is opened per
  // request, after this module has loaded.
  async function chunks() {
    const col = cfg.collection();
    if (!indexed)
      indexed = Promise.all([
        col.createIndex({ key: 1, n: 1 }),
        col.createIndex({ upload: 1 }),
      ]).catch((err) => {
        indexed = null;
        throw err;
      });
    await indexed;
    return col;
  }

  return {
    mode: 'db',
    maxBytes: DB_MAX_BYTES,
    partBytes: DB_PART,
    sign,
    verify,

    async createUpload({ size }) {
      const uploadId = crypto.randomUUID();
      const count = Math.max(1, Math.ceil(size / DB_PART));
      const exp = Math.floor(Date.now() / 1000) + PUT_TTL;
      const parts = [];
      for (let n = 1; n <= count; n++) {
        parts.push({
          partNumber: n,
          url:
            '/api/storage/db/part?token=' +
            encodeURIComponent(sign({ op: 'put', uploadId, part: n, exp })),
        });
      }
      return { uploadId, partSize: DB_PART, parts };
    },

    // Called by the part route. A retried part replaces the first attempt.
    async putPart({ uploadId, part, bytes }) {
      const col = await chunks();
      await col.replaceOne(
        { _id: uploadId + ':' + part },
        { upload: uploadId, key: null, n: part, size: bytes.length, data: bytes, at: new Date() },
        { upsert: true }
      );
    },

    async completeUpload({ key, uploadId, parts }) {
      const col = await chunks();
      const have = await col.countDocuments({ upload: uploadId });
      if (have !== parts.length)
        throw shownError('Part of that upload did not arrive. Try again.', 502);
      await col.updateMany({ upload: uploadId }, { $set: { key } });
      return { etag: null };
    },

    async abortUpload({ uploadId }) {
      const col = await chunks();
      await col.deleteMany({ upload: uploadId });
    },

    async head({ key }) {
      const col = await chunks();
      const list = await col.find({ key }, { projection: { size: 1 } }).toArray();
      if (!list.length) return null;
      return { size: list.reduce((a, c) => a + (c.size || 0), 0), contentType: null };
    },

    // The whole object, parts in order. Only ever small — see DB_MAX_BYTES.
    async read({ key }) {
      const col = await chunks();
      const list = await col.find({ key }).sort({ n: 1 }).toArray();
      if (!list.length) return null;
      return Buffer.concat(list.map((c) => chunkBytes(c.data)));
    },

    async presignGet({ key, filename, contentType, download, ttl }) {
      const exp = Math.floor(Date.now() / 1000) + (ttl || GET_TTL);
      return (
        '/api/storage/db/object?token=' +
        encodeURIComponent(
          sign({ op: 'get', key, filename, ct: contentType || '', download: !!download, exp })
        )
      );
    },

    async remove({ key }) {
      const col = await chunks();
      await col.deleteMany({ key });
    },
  };
}

// ---------------------------------------------------------------------------
// Driver selection
// ---------------------------------------------------------------------------

function readConfig() {
  return {
    bucket: process.env.S3_BUCKET || '',
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    // R2/B2/Supabase need it; AWS does not mind.
    forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || 'true') !== 'false',
  };
}

const cfg = readConfig();
const s3Configured = !!(cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey);
// A serverless filesystem is read-only apart from /tmp, which is wiped between
// invocations — so the local driver is never a silent production fallback.
const serverless = !!(process.env.NETLIFY || process.env.VERCEL || process.env.AWS_REGION);
const forced = (process.env.STORAGE_DRIVER || '').toLowerCase();

const SECRET = process.env.SESSION_SECRET || 'hek-timeclock-dev-secret-please-change';

let driver;
let reason;
if (forced === 'db' || (!s3Configured && serverless && forced !== 's3' && forced !== 'local')) {
  // A deployed site with no bucket. Before this existed it refused every
  // upload, and the office saw only "Server error." against each file.
  driver = dbDriver({
    secret: SECRET,
    collection: () => {
      const { store } = require('./db');
      if (!store.db) throw new Error('The database is not connected.');
      return store.db.collection('file_chunks');
    },
  });
  reason = s3Configured
    ? 'STORAGE_DRIVER=db'
    : 'no S3 bucket configured — attachments up to 4 MB are kept in MongoDB';
} else if (forced === 'local' || (!s3Configured && !serverless && forced !== 's3')) {
  driver = localDriver({
    dir: process.env.STORAGE_DIR || path.join(__dirname, '.storage'),
    secret: SECRET,
  });
  reason = s3Configured
    ? 'STORAGE_DRIVER=local'
    : 'no S3 bucket configured — attachments are kept on this machine';
} else if (s3Configured) {
  driver = s3Driver(cfg);
  reason = `bucket ${cfg.bucket}`;
} else {
  // Deployed with no bucket: fail loudly at the point of use rather than
  // pretend to store a file that would vanish with the invocation.
  const missing = shownError(
    'File storage is not configured. Set S3_BUCKET, S3_ACCESS_KEY_ID, ' +
      'S3_SECRET_ACCESS_KEY (and S3_ENDPOINT for Cloudflare R2).',
    503
  );
  driver = {
    mode: 'unconfigured',
    createUpload: async () => { throw missing; },
    completeUpload: async () => { throw missing; },
    abortUpload: async () => {},
    head: async () => null,
    presignGet: async () => { throw missing; },
    remove: async () => {},
  };
  reason = 'not configured';
}

console.log(`[storage] driver: ${driver.mode} (${reason})`);

module.exports = {
  storage: driver,
  // The cap that applies here: the db driver can only carry a few MB.
  MAX_UPLOAD_BYTES: driver.maxBytes ? Math.min(driver.maxBytes, MAX_UPLOAD_BYTES) : MAX_UPLOAD_BYTES,
  GET_TTL,
  buildKey,
  disposition,
};
