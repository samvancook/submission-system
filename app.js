const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_FILE_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".rtf", ".txt"]);

const statusColors = {
  Received: "rgba(45, 74, 54, 0.12)",
  "In Review": "rgba(217, 164, 65, 0.18)",
  Shortlisted: "rgba(187, 77, 0, 0.14)",
  Accepted: "rgba(16, 185, 129, 0.15)",
  Declined: "rgba(100, 116, 139, 0.18)"
};

const statusTextColors = {
  Received: "#2d4a36",
  "In Review": "#8a5b00",
  Shortlisted: "#8a2f09",
  Accepted: "#0f766e",
  Declined: "#475569"
};

const state = {
  programs: [],
  submissions: [],
  selectedId: null,
  isLoading: true,
  filters: {
    search: "",
    status: "all",
    programId: "all"
  }
};

const form = document.querySelector("#submission-form");
const formFeedback = document.querySelector("#form-feedback");
const submissionList = document.querySelector("#submission-list");
const submissionDetail = document.querySelector("#submission-detail");
const searchInput = document.querySelector("#search-input");
const statusFilter = document.querySelector("#status-filter");
const programFilter = document.querySelector("#program-filter");
const programSelect = form.elements.programId;
const submitButton = form.querySelector('button[type="submit"]');
const attachmentInput = form.elements.attachment;
const uploadField = document.querySelector("#upload-field");
const uploadDropzone = document.querySelector("#upload-dropzone");
const uploadBrowse = document.querySelector("#upload-browse");
const uploadSummary = document.querySelector("#upload-summary");

bindEvents();
initializeApp();

async function initializeApp() {
  try {
    const response = await fetch("/api/bootstrap");
    const data = await response.json();

    state.programs = data.programs || [];
    state.submissions = data.submissions || [];
    hydrateStaticOptions();
  } catch (error) {
    formFeedback.textContent = "The app could not load submission data.";
    console.error(error);
  } finally {
    state.isLoading = false;
    render();
  }
}

function hydrateStaticOptions() {
  programSelect.innerHTML = state.programs.map((program) => (
    `<option value="${program.id}">${program.name} ${program.fee ? `($${program.fee})` : "(Free)"}</option>`
  )).join("");

  programFilter.innerHTML = `<option value="all">All programs</option>${state.programs.map((program) => (
    `<option value="${program.id}">${program.name}</option>`
  )).join("")}`;

  const statuses = ["Received", "In Review", "Shortlisted", "Accepted", "Declined"];
  statusFilter.innerHTML = `<option value="all">All statuses</option>${statuses.map((status) => (
    `<option value="${status}">${status}</option>`
  )).join("")}`;

  document.querySelector("#program-list").innerHTML = state.programs.map((program) => `
    <div class="callout-item">
      <strong>${program.name}</strong>
      <span>Closes ${program.dueDate} · ${program.fee ? `$${program.fee} fee` : "No fee"}</span>
      <span>${program.description}</span>
    </div>
  `).join("");

  if (state.programs.length) {
    programSelect.value = state.programs[0].id;
  }
}

function bindEvents() {
  form.addEventListener("submit", handleSubmit);
  attachmentInput.addEventListener("change", handleAttachmentSelection);
  uploadBrowse.addEventListener("click", () => attachmentInput.click());
  uploadDropzone.addEventListener("click", () => attachmentInput.click());
  uploadDropzone.addEventListener("keydown", handleDropzoneKeydown);
  uploadDropzone.addEventListener("dragenter", handleDragEvent);
  uploadDropzone.addEventListener("dragover", handleDragEvent);
  uploadDropzone.addEventListener("dragleave", handleDragLeave);
  uploadDropzone.addEventListener("drop", handleDrop);
  searchInput.addEventListener("input", (event) => {
    state.filters.search = event.target.value.trim().toLowerCase();
    render();
  });
  statusFilter.addEventListener("change", (event) => {
    state.filters.status = event.target.value;
    render();
  });
  programFilter.addEventListener("change", (event) => {
    state.filters.programId = event.target.value;
    render();
  });
}

async function handleSubmit(event) {
  event.preventDefault();
  const formData = new FormData(form);
  const entry = Object.fromEntries(formData.entries());
  const program = getProgram(entry.programId);
  const attachment = attachmentInput.files[0];

  if (!attachment) {
    formFeedback.textContent = "Please attach a file before submitting.";
    return;
  }

  const clientValidationError = validateAttachment(attachment);
  if (clientValidationError) {
    formFeedback.textContent = clientValidationError;
    return;
  }

  formData.set("fee", entry.fee || program.fee || 0);

  formFeedback.textContent = `Uploading ${attachment.name}...`;
  submitButton.disabled = true;

  try {
    const response = await fetch("/api/submissions", {
      method: "POST",
      body: formData
    });
    const data = await response.json();

    if (!response.ok) {
      formFeedback.textContent = data.error || "Something went wrong while saving the submission.";
      return;
    }

    const submission = data.submission;
    state.submissions = [submission, ...state.submissions];
    state.selectedId = submission.id;
    form.reset();
    form.elements.programId.value = state.programs[0]?.id || "";
    updateUploadSummary();
    formFeedback.textContent = `${submission.title} by ${submission.authorName} is now in the review queue.`;
    render();
  } catch (error) {
    formFeedback.textContent = "The submission could not be saved.";
    console.error(error);
  } finally {
    submitButton.disabled = false;
  }
}

function render() {
  renderMetrics();
  renderSubmissionList();
  renderSubmissionDetail();
}

function renderMetrics() {
  if (state.isLoading) {
    document.querySelector("#metric-submissions").textContent = "…";
    document.querySelector("#metric-open").textContent = "…";
    document.querySelector("#metric-shortlist").textContent = "…";
    return;
  }

  document.querySelector("#metric-submissions").textContent = state.submissions.length;
  document.querySelector("#metric-open").textContent = state.submissions.filter((item) => (
    item.status === "Received" || item.status === "In Review"
  )).length;
  document.querySelector("#metric-shortlist").textContent = state.submissions.filter((item) => item.status === "Shortlisted").length;
}

function renderSubmissionList() {
  if (state.isLoading) {
    submissionList.innerHTML = `<div class="queue-empty">Loading submissions...</div>`;
    return;
  }

  const items = getFilteredSubmissions();
  submissionList.innerHTML = "";

  if (!items.length) {
    submissionList.innerHTML = `<div class="queue-empty">No submissions match the current filters.</div>`;
    if (!getSelectedSubmission()) {
      state.selectedId = null;
    }
    return;
  }

  if (!state.selectedId || !items.some((item) => item.id === state.selectedId)) {
    state.selectedId = items[0].id;
  }

  const template = document.querySelector("#submission-card-template");

  items.forEach((submission) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.classList.toggle("active", submission.id === state.selectedId);
    node.querySelector(".submission-title").textContent = submission.title;
    node.querySelector(".submission-meta").textContent = `${submission.authorName} · ${submission.genre} · ${submission.wordCount.toLocaleString()} words`;
    node.querySelector(".submission-program").textContent = `${getProgram(submission.programId).name} · ${formatDate(submission.createdAt)}`;

    const pill = node.querySelector(".pill");
    pill.textContent = submission.status;
    pill.style.background = statusColors[submission.status];
    pill.style.color = statusTextColors[submission.status];

    node.addEventListener("click", () => {
      state.selectedId = submission.id;
      renderSubmissionList();
      renderSubmissionDetail();
    });

    submissionList.appendChild(node);
  });
}

function renderSubmissionDetail() {
  if (state.isLoading) {
    submissionDetail.className = "submission-detail empty-state";
    submissionDetail.innerHTML = `
      <h3>Loading workspace</h3>
      <p>Pulling programs and submission data from the server.</p>
    `;
    return;
  }

  const submission = getSelectedSubmission();
  if (!submission) {
    submissionDetail.className = "submission-detail empty-state";
    submissionDetail.innerHTML = `
      <h3>Select a submission</h3>
      <p>Choose a piece from the queue to inspect metadata, read the cover letter, add editorial notes, and update its status.</p>
    `;
    return;
  }

  const program = getProgram(submission.programId);
  submissionDetail.className = "submission-detail";
  submissionDetail.innerHTML = `
    <div class="detail-title-row">
      <div>
        <p class="section-kicker">Submission detail</p>
        <h2>${submission.title}</h2>
        <p class="muted">${submission.authorName} · ${submission.email}</p>
      </div>
      <span class="pill" style="background:${statusColors[submission.status]}; color:${statusTextColors[submission.status]}">${submission.status}</span>
    </div>

    <div class="detail-grid">
      <div class="detail-item"><span>Program</span><strong>${program.name}</strong></div>
      <div class="detail-item"><span>Received</span><strong>${formatDate(submission.createdAt)}</strong></div>
      <div class="detail-item"><span>Genre</span><strong>${submission.genre}</strong></div>
      <div class="detail-item"><span>Fee paid</span><strong>$${submission.fee.toFixed(2)}</strong></div>
      <div class="detail-item"><span>Word count</span><strong>${submission.wordCount.toLocaleString()}</strong></div>
      <div class="detail-item"><span>Attachment</span><strong>${renderAttachment(submission)}</strong></div>
    </div>

    <div class="detail-block">
      <h3>Cover letter</h3>
      <p class="muted">${submission.coverLetter}</p>
    </div>

    <div class="detail-block">
      <h3>Editorial notes</h3>
      <textarea class="notes-box" id="notes-input" placeholder="Add a private note for the review team...">${submission.notes || ""}</textarea>
    </div>

    <div class="detail-block">
      <h3>Decision</h3>
      <div class="detail-actions">
        <label>
          Status
          <select id="detail-status">
            ${["Received", "In Review", "Shortlisted", "Accepted", "Declined"].map((status) => (
              `<option value="${status}" ${status === submission.status ? "selected" : ""}>${status}</option>`
            )).join("")}
          </select>
        </label>
        <button class="primary-button" id="save-review" type="button">Save review update</button>
      </div>
    </div>
  `;

  document.querySelector("#save-review").addEventListener("click", async () => {
    const nextStatus = document.querySelector("#detail-status").value;
    const nextNotes = document.querySelector("#notes-input").value.trim();
    await updateSubmission(submission.id, { status: nextStatus, notes: nextNotes });
  });
}

async function updateSubmission(id, changes) {
  try {
    const response = await fetch(`/api/submissions/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(changes)
    });
    const data = await response.json();

    if (!response.ok) {
      formFeedback.textContent = data.error || "The review update could not be saved.";
      return;
    }

    state.submissions = state.submissions.map((submission) => (
      submission.id === id ? data.submission : submission
    ));
    formFeedback.textContent = "Review update saved.";
    render();
  } catch (error) {
    formFeedback.textContent = "The review update could not be saved.";
    console.error(error);
  }
}

function getFilteredSubmissions() {
  return [...state.submissions]
    .filter((submission) => {
      const matchesSearch = !state.filters.search || [
        submission.title,
        submission.authorName,
        submission.email
      ].some((value) => value.toLowerCase().includes(state.filters.search));

      const matchesStatus = state.filters.status === "all" || submission.status === state.filters.status;
      const matchesProgram = state.filters.programId === "all" || submission.programId === state.filters.programId;

      return matchesSearch && matchesStatus && matchesProgram;
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getSelectedSubmission() {
  return state.submissions.find((submission) => submission.id === state.selectedId) || null;
}

function getProgram(programId) {
  return state.programs.find((program) => program.id === programId) || state.programs[0];
}

function formatDate(dateString) {
  return new Date(dateString).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function renderAttachment(submission) {
  if (submission.attachmentUrl) {
    return `<a href="${submission.attachmentUrl}" target="_blank" rel="noreferrer">${submission.attachmentName}</a>`;
  }

  return submission.attachmentName;
}

function handleAttachmentSelection() {
  updateUploadSummary();

  const attachment = attachmentInput.files[0];
  if (!attachment) {
    return;
  }

  const validationError = validateAttachment(attachment);
  if (validationError) {
    formFeedback.textContent = validationError;
    uploadField.classList.add("is-invalid");
    return;
  }

  formFeedback.textContent = `${attachment.name} is ready to upload.`;
}

function handleDropzoneKeydown(event) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    attachmentInput.click();
  }
}

function handleDragEvent(event) {
  event.preventDefault();
  uploadField.classList.add("is-dragging");
}

function handleDragLeave(event) {
  event.preventDefault();

  if (!uploadField.contains(event.relatedTarget)) {
    uploadField.classList.remove("is-dragging");
  }
}

function handleDrop(event) {
  event.preventDefault();
  uploadField.classList.remove("is-dragging");

  const [file] = event.dataTransfer.files;
  if (!file) {
    return;
  }

  const transfer = new DataTransfer();
  transfer.items.add(file);
  attachmentInput.files = transfer.files;
  handleAttachmentSelection();
}

function updateUploadSummary() {
  const attachment = attachmentInput.files[0];
  uploadField.classList.remove("is-invalid");
  uploadField.classList.remove("is-dragging");

  if (!attachment) {
    uploadSummary.className = "upload-summary is-empty";
    uploadSummary.innerHTML = `
      <strong>No file selected</strong>
      <span>Accepted formats: PDF, DOC, DOCX, RTF, TXT</span>
    `;
    return;
  }

  const validationError = validateAttachment(attachment);
  const extension = getFileExtension(attachment.name).replace(".", "").toUpperCase() || "FILE";
  const sizeLabel = formatFileSize(attachment.size);

  uploadSummary.className = validationError ? "upload-summary is-invalid" : "upload-summary is-ready";
  uploadSummary.innerHTML = `
    <strong>${attachment.name}</strong>
    <span>${extension} · ${sizeLabel}</span>
  `;

  if (validationError) {
    uploadField.classList.add("is-invalid");
    uploadSummary.innerHTML += `<span>${validationError}</span>`;
  }
}

function validateAttachment(file) {
  const extension = getFileExtension(file.name);

  if (!ALLOWED_FILE_EXTENSIONS.has(extension)) {
    return "Please upload a PDF, DOC, DOCX, RTF, or TXT file.";
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return "Please upload a file smaller than 10 MB.";
  }

  return null;
}

function getFileExtension(fileName) {
  const parts = fileName.toLowerCase().split(".");
  return parts.length > 1 ? `.${parts.pop()}` : "";
}

function formatFileSize(sizeInBytes) {
  if (sizeInBytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(sizeInBytes / 1024))} KB`;
  }

  return `${(sizeInBytes / (1024 * 1024)).toFixed(1)} MB`;
}
