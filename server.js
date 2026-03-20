const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");
const { Storage } = require("@google-cloud/storage");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const ROOT_DIR = __dirname;
const DATA_PATH = path.join(ROOT_DIR, "data", "store.json");
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(ROOT_DIR, "uploads");
const GCS_BUCKET = process.env.GCS_BUCKET || "";
const GCS_STORE_OBJECT = process.env.GCS_STORE_OBJECT || "data/store.json";
const PUBLIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/app.js", "app.js"]
]);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".rtf": "application/rtf",
  ".txt": "text/plain; charset=utf-8"
};

const VALID_STATUSES = new Set(["Received", "In Review", "Shortlisted", "Accepted", "Declined"]);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_MULTIPART_BODY_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024;
const ALLOWED_FILE_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".rtf", ".txt"]);
const storage = GCS_BUCKET ? new Storage() : null;

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    await serveStatic(response, url.pathname);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const message = statusCode === 500 ? "Internal server error" : error.message;
    sendJson(response, statusCode, { error: message });
    if (statusCode >= 500) {
      console.error(error);
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Slatehouse running at http://${HOST}:${PORT}`);
});

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    const store = await readStore();
    sendJson(response, 200, store);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/submissions") {
    const contentType = request.headers["content-type"] || "";
    const payload = contentType.includes("multipart/form-data")
      ? await readMultipartBody(request, contentType)
      : await readJsonBody(request);
    const store = await readStore();
    const program = store.programs.find((item) => item.id === payload.programId);

    if (!program) {
      sendJson(response, 400, { error: "Program is required." });
      return;
    }

    const validationError = validateNewSubmission(payload);
    if (validationError) {
      sendJson(response, 400, { error: validationError });
      return;
    }

    const uploadedFile = await persistUploadedFile(payload.attachment);

    const submission = {
      id: randomUUID(),
      programId: payload.programId,
      authorName: payload.authorName.trim(),
      email: payload.email.trim(),
      title: payload.title.trim(),
      genre: payload.genre.trim(),
      wordCount: Number(payload.wordCount),
      fee: payload.fee === "" || payload.fee === undefined ? Number(program.fee || 0) : Number(payload.fee),
      coverLetter: payload.coverLetter.trim(),
      attachmentName: uploadedFile.originalName,
      attachmentStoredName: uploadedFile.storedName,
      attachmentUrl: uploadedFile.url,
      status: "Received",
      notes: "",
      createdAt: new Date().toISOString()
    };

    store.submissions.unshift(submission);
    await writeStore(store);
    sendJson(response, 201, { submission });
    return;
  }

  if (request.method === "PATCH" && url.pathname.startsWith("/api/submissions/")) {
    const submissionId = url.pathname.split("/").pop();
    const payload = await readJsonBody(request);
    const store = await readStore();
    const index = store.submissions.findIndex((item) => item.id === submissionId);

    if (index === -1) {
      sendJson(response, 404, { error: "Submission not found." });
      return;
    }

    const nextSubmission = { ...store.submissions[index] };

    if (payload.status !== undefined) {
      if (!VALID_STATUSES.has(payload.status)) {
        sendJson(response, 400, { error: "Status is invalid." });
        return;
      }
      nextSubmission.status = payload.status;
    }

    if (payload.notes !== undefined) {
      nextSubmission.notes = String(payload.notes).trim();
    }

    store.submissions[index] = nextSubmission;
    await writeStore(store);
    sendJson(response, 200, { submission: nextSubmission });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

async function serveStatic(response, pathname) {
  if (pathname.startsWith("/uploads/")) {
    await serveUpload(response, pathname);
    return;
  }

  const fileName = PUBLIC_FILES.get(pathname);

  if (!fileName) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const filePath = path.join(ROOT_DIR, fileName);
  const extension = path.extname(filePath);
  const content = await fs.readFile(filePath);

  response.writeHead(200, { "Content-Type": CONTENT_TYPES[extension] || "application/octet-stream" });
  response.end(content);
}

async function serveUpload(response, pathname) {
  if (GCS_BUCKET) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const fileName = path.basename(pathname);
  const filePath = path.join(UPLOADS_DIR, fileName);

  if (!filePath.startsWith(UPLOADS_DIR)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  try {
    const extension = path.extname(filePath).toLowerCase();
    const content = await fs.readFile(filePath);
    response.writeHead(200, { "Content-Type": CONTENT_TYPES[extension] || "application/octet-stream" });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

async function readStore() {
  if (GCS_BUCKET) {
    try {
      const [content] = await storage.bucket(GCS_BUCKET).file(GCS_STORE_OBJECT).download();
      return JSON.parse(content.toString("utf8"));
    } catch (error) {
      if (error.code === 404) {
        const raw = await fs.readFile(DATA_PATH, "utf8");
        const seedStore = JSON.parse(raw);
        await writeStore(seedStore);
        return seedStore;
      }
      throw error;
    }
  }

  const raw = await fs.readFile(DATA_PATH, "utf8");
  return JSON.parse(raw);
}

async function writeStore(store) {
  const serialized = `${JSON.stringify(store, null, 2)}\n`;

  if (GCS_BUCKET) {
    await storage.bucket(GCS_BUCKET).file(GCS_STORE_OBJECT).save(serialized, {
      contentType: "application/json; charset=utf-8"
    });
    return;
  }

  await fs.writeFile(DATA_PATH, serialized, "utf8");
}

async function readJsonBody(request) {
  const rawBody = await readRawBody(request, MAX_JSON_BODY_BYTES);

  if (!rawBody.length) {
    return {};
  }

  return JSON.parse(rawBody.toString("utf8"));
}

async function readMultipartBody(request, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);

  if (!boundaryMatch) {
    throw new Error("Missing multipart boundary");
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const rawBody = await readRawBody(request, MAX_MULTIPART_BODY_BYTES);
  return parseMultipartForm(rawBody, boundary);
}

async function readRawBody(request, maxBytes = MAX_MULTIPART_BODY_BYTES) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;

    if (totalBytes > maxBytes) {
      throw createHttpError(413, "Upload exceeds the 10 MB limit.");
    }

    chunks.push(chunk);
  }

  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}

function parseMultipartForm(body, boundary) {
  const fields = {};
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  let cursor = body.indexOf(boundaryBuffer);

  while (cursor !== -1) {
    cursor += boundaryBuffer.length;

    if (body.slice(cursor, cursor + 2).equals(Buffer.from("--"))) {
      break;
    }

    if (body.slice(cursor, cursor + 2).equals(Buffer.from("\r\n"))) {
      cursor += 2;
    }

    const nextBoundary = body.indexOf(boundaryBuffer, cursor);
    if (nextBoundary === -1) {
      break;
    }

    const part = body.slice(cursor, nextBoundary - 2);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));

    if (headerEnd === -1) {
      cursor = nextBoundary;
      continue;
    }

    const headerText = part.slice(0, headerEnd).toString("utf8");
    const content = part.slice(headerEnd + 4);
    const disposition = headerText.split("\r\n").find((line) => line.toLowerCase().startsWith("content-disposition"));
    const nameMatch = disposition?.match(/name="([^"]+)"/i);
    const fileNameMatch = disposition?.match(/filename="([^"]*)"/i);

    if (!nameMatch) {
      cursor = nextBoundary;
      continue;
    }

    const fieldName = nameMatch[1];
    if (fileNameMatch && fileNameMatch[1]) {
      fields[fieldName] = {
        originalName: sanitizeFileName(fileNameMatch[1]),
        content
      };
    } else {
      fields[fieldName] = content.toString("utf8");
    }

    cursor = nextBoundary;
  }

  return fields;
}

async function persistUploadedFile(file) {
  const fileError = validateAttachmentFile(file);
  if (fileError) {
    throw createHttpError(400, fileError);
  }

  const safeName = sanitizeFileName(file.originalName);
  const storedName = `${randomUUID()}-${safeName}`;
  const storedPath = `uploads/${storedName}`;

  if (GCS_BUCKET) {
    const bucket = storage.bucket(GCS_BUCKET);
    const uploadedFile = bucket.file(storedPath);
    await uploadedFile.save(file.content, {
      contentType: CONTENT_TYPES[path.extname(safeName).toLowerCase()] || "application/octet-stream"
    });

    return {
      originalName: safeName,
      storedName,
      url: `https://storage.googleapis.com/${GCS_BUCKET}/${storedPath}`
    };
  }

  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  const filePath = path.join(UPLOADS_DIR, storedName);
  await fs.writeFile(filePath, file.content);

  return {
    originalName: safeName,
    storedName,
    url: `/uploads/${storedName}`
  };
}

function validateNewSubmission(payload) {
  if (!payload.authorName || !payload.authorName.trim()) {
    return "Author name is required.";
  }
  if (!payload.email || !payload.email.trim()) {
    return "Email is required.";
  }
  if (!payload.title || !payload.title.trim()) {
    return "Project title is required.";
  }
  if (!payload.genre || !payload.genre.trim()) {
    return "Genre is required.";
  }
  if (!Number.isFinite(Number(payload.wordCount)) || Number(payload.wordCount) < 1) {
    return "Word count must be at least 1.";
  }
  if (!Number.isFinite(Number(payload.fee)) && payload.fee !== "" && payload.fee !== undefined) {
    return "Submission fee must be a number.";
  }
  if (!payload.coverLetter || !payload.coverLetter.trim()) {
    return "Cover letter is required.";
  }
  return validateAttachmentFile(payload.attachment);
}

function sanitizeFileName(fileName) {
  return path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "-");
}

function validateAttachmentFile(file) {
  if (!file || !file.originalName || !file.content?.length) {
    return "An attachment file is required.";
  }

  const extension = path.extname(file.originalName).toLowerCase();
  if (!ALLOWED_FILE_EXTENSIONS.has(extension)) {
    return "Attachment must be a PDF, DOC, DOCX, RTF, or TXT file.";
  }

  if (file.content.length > MAX_UPLOAD_BYTES) {
    return "Attachment must be smaller than 10 MB.";
  }

  return null;
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
