// Direct-to-storage file uploads, shared by job files and task attachments.
//
// The old path read the whole file into memory, base64'd it, and posted it as
// JSON — which capped attachments at about 4 MB, because the request and the
// response both had to fit through a serverless function. Here the app only ever
// exchanges small JSON messages:
//
//   1. POST <base>/upload-url      -> { fileId, partSize, parts: [{partNumber, url}] }
//   2. PUT each part straight to storage (never through the app)
//   3. POST <base>/<fileId>/complete with the parts and their ETags
//
// If anything after step 1 fails, POST <base>/<fileId>/abort deletes the
// pending row and whatever parts had already landed.
//
// Parts mean a dropped connection on a phone costs one 10 MB part, not the whole
// gigabyte — which is the difference between "retry" and "give up".
(function () {
  const H = () => window.HEKAdmin || {};

  // How many parts travel at once. Three keeps a phone's uplink saturated
  // without starving the rest of the page or tripping provider rate limits.
  const CONCURRENCY = 3;
  const PART_RETRIES = 3;

  // One part, with retries. Resolves to the ETag the server needs to stitch the
  // object back together in order.
  function putPart(url, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      // Progress is why this is XHR and not fetch: fetch cannot report upload
      // progress, and a gigabyte with no feedback looks like a hung page.
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          // S3-compatible storage returns the part's ETag; the local dev driver
          // mimics it. Either way it has to be readable — see the CORS note in
          // README (ExposeHeaders must include ETag).
          resolve(xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag') || undefined);
        } else {
          reject(new Error('Upload failed (' + xhr.status + ').'));
        }
      };
      xhr.onerror = () => reject(new Error('The connection dropped mid-upload.'));
      xhr.onabort = () => reject(new Error('Upload cancelled.'));
      xhr.send(blob);
    });
  }

  // ---- photos are made smaller before they go ----
  //
  // A phone photo is 3–12 MB. Anything over SHRINK_OVER is redrawn at most
  // MAX_EDGE pixels on its long side and saved as WebP (JPEG on a browser that
  // can't write WebP), usually a tenth of the size: a job's photos go up in
  // seconds on a crew's mobile data instead of minutes, and open faster for
  // everyone afterwards. The work happens in a worker (imgworker.js), so the
  // page never freezes while a 12-megapixel picture is decoded.
  //
  // Left exactly as they are: anything that isn't a JPEG, WebP or HEIC photo
  // (a PNG screenshot keeps its crisp text, a GIF its animation; documents are
  // never touched), photos that are already small, and anything that fails to
  // decode or doesn't come out at least a tenth smaller. Re-saving drops the
  // camera's EXIF data — including where the photo was taken — but never the
  // way up: see imgworker.js.
  const SHRINK_OVER = 700 * 1024;
  const MAX_EDGE = 2560;
  const QUALITY = 0.82;
  const PHOTO = /^image\/(jpeg|pjpeg|webp|heic|heif)$/i;

  let worker = null;
  let workerFailed = false;
  let asked = 0;
  const replies = new Map();
  // Whether this browser turns photos upright while decoding them — learnt
  // from the first sideways photo, and needed for mirrored/upside-down ones.
  let turnsUpright;

  function shrinker() {
    if (worker || workerFailed || typeof Worker !== 'function') return worker;
    try {
      worker = new Worker('/imgworker.js');
      worker.onmessage = (e) => {
        const done = replies.get(e.data.id);
        if (done) done(e.data);
      };
      worker.onerror = () => {
        // The worker itself is broken (not one photo): send everything as is.
        workerFailed = true;
        worker = null;
        for (const done of replies.values()) done({ error: 'worker' });
      };
    } catch (e) {
      workerFailed = true;
      worker = null;
    }
    return worker;
  }

  async function shrink(file) {
    if (!file || !PHOTO.test(file.type || '') || file.size <= SHRINK_OVER) return file;
    const w = shrinker();
    if (!w) return file;
    const reply = await new Promise((resolve) => {
      const id = ++asked;
      // A photo that takes this long to redraw goes up as it is.
      const timer = setTimeout(() => finish({ error: 'timeout' }), 20000);
      function finish(msg) {
        clearTimeout(timer);
        replies.delete(id);
        resolve(msg);
      }
      replies.set(id, finish);
      w.postMessage({ id, file, maxEdge: MAX_EDGE, quality: QUALITY, applied: turnsUpright });
    });
    if (typeof reply.oriented === 'boolean') turnsUpright = reply.oriented;
    const blob = reply.blob;
    if (!blob || blob.size >= file.size * 0.9) return file;
    const ext = blob.type === 'image/webp' ? '.webp' : '.jpg';
    const name = (file.name || 'photo').replace(/\.(jpe?g|jfif|pjpeg|webp|heic|heif)$/i, '') + ext;
    try {
      return new File([blob], name, { type: blob.type, lastModified: file.lastModified });
    } catch (e) {
      return file; // a browser without the File constructor
    }
  }

  // Upload one File. `base` is the collection endpoint, e.g.
  // "/api/admin/schedules/12/files" or "/api/admin/tasks/3/attachments".
  //
  // onProgress(fraction) is called as bytes land, 0..1.
  async function upload({ base, file: picked, extra, onProgress }) {
    const api = H().api;
    const report = typeof onProgress === 'function' ? onProgress : () => {};
    const file = await shrink(picked);

    // Step 1 — ask permission and get the URLs. The server decides the cap, so a
    // file that is too large is refused here, before a byte moves.
    const plan = await api(base + '/upload-url', {
      method: 'POST',
      body: JSON.stringify({
        filename: file.name,
        content_type: file.type || 'application/octet-stream',
        size: file.size,
        ...(extra || {}),
      }),
    });

    // From here on a pending row exists, maybe with parts in the bucket, and
    // nothing lists a pending row — so nobody could remove it by hand. Any way
    // out short of a finished upload (a part that won't go, a completion that
    // fails or never answers) takes it back down. Abort skips a row that is no
    // longer pending, so a completion that landed despite the error is kept.
    try {
      return await transfer(api, base, file, plan, report);
    } catch (err) {
      try {
        await api(base + '/' + plan.fileId + '/abort', { method: 'POST' });
      } catch (e) {
        /* the row is already orphaned; the error that matters is the upload's */
      }
      throw err;
    }
  }

  // Steps 2 and 3. Throws on any failure and leaves the cleanup to upload().
  async function transfer(api, base, file, plan, report) {
    const { fileId, partSize, parts } = plan;
    // Bytes confirmed per part, so overall progress stays honest when parts
    // finish out of order.
    const done = new Array(parts.length).fill(0);
    const total = file.size || 1;
    const tick = () => report(Math.min(1, done.reduce((a, b) => a + b, 0) / total));

    const etags = new Array(parts.length);
    let next = 0;
    let failure = null;

    // A small worker pool rather than Promise.all over every part: a 1 GB file is
    // 100 parts, and starting 100 uploads at once is how a phone's connection
    // collapses.
    async function worker() {
      while (true) {
        const i = next++;
        if (i >= parts.length || failure) return;
        const from = i * partSize;
        // Keep the MIME type on the slice: Blob.slice() drops it otherwise, and
        // the browser then sends the part with no Content-Type header at all.
        const blob = file.slice(
          from,
          Math.min(from + partSize, file.size),
          file.type || 'application/octet-stream'
        );
        for (let attempt = 1; ; attempt++) {
          try {
            etags[i] = await putPart(parts[i].url, blob, (loaded) => {
              done[i] = loaded;
              tick();
            });
            done[i] = blob.size;
            tick();
            break;
          } catch (err) {
            // Start this part's progress over — its bytes did not land.
            done[i] = 0;
            tick();
            if (attempt >= PART_RETRIES) {
              failure = err;
              return;
            }
            // Back off a little before retrying; an instant retry on a flaky
            // mobile connection usually fails the same way.
            await new Promise((r) => setTimeout(r, 400 * attempt));
          }
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, parts.length) }, () => worker())
    );

    // Every worker has stopped by now, so no part is still in flight when
    // upload() aborts — one landing after the abort would be left behind.
    if (failure) throw failure;

    // Step 3 — the app files the metadata and the attachment becomes visible.
    const meta = await api(base + '/' + fileId + '/complete', {
      method: 'POST',
      body: JSON.stringify({
        parts: parts.map((p, i) => ({ partNumber: p.partNumber, etag: etags[i] })),
      }),
    });
    report(1);
    return meta;
  }

  window.HEKUpload = { upload };
})();
