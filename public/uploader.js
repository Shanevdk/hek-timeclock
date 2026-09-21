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

  // Upload one File. `base` is the collection endpoint, e.g.
  // "/api/admin/schedules/12/files" or "/api/admin/tasks/3/attachments".
  //
  // onProgress(fraction) is called as bytes land, 0..1.
  async function upload({ base, file, extra, onProgress }) {
    const api = H().api;
    const report = typeof onProgress === 'function' ? onProgress : () => {};

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

    if (failure) {
      // Don't leave a half-written object behind on the way out.
      try {
        await api(base + '/' + fileId + '/abort', { method: 'POST' });
      } catch (err) {
        /* the row is already orphaned; the error that matters is the upload's */
      }
      throw failure;
    }

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
