# Slatehouse Submission System MVP

This workspace now contains a lightweight submission system with a dependency-free Node backend and JSON-backed persistence.

## Included flows

- public-facing submission form
- seeded calls for submissions
- editorial dashboard with search and filters
- submission detail view with metadata, cover letter, notes, and status updates
- file-backed persistence in `data/store.json`
- JSON API for programs and submissions
- real uploaded files saved to `uploads/`

## Run it

Run:

```bash
npm start
```

Then open [http://localhost:3000](http://localhost:3000).

## Notes

This is an MVP prototype built in plain HTML, CSS, JavaScript, and a minimal Node server so it can run immediately in an empty workspace without package installs.

Uploads are stored on disk in `/Users/buttonpublishingone/Desktop/CODEX/Submission System Creation/uploads/` and new submissions keep a link to the saved file for reviewer access.

Current upload constraints:

- accepted file types: PDF, DOC, DOCX, RTF, TXT
- max file size: 10 MB
- validation runs in both the browser and the server
- the intake form supports drag-and-drop uploads and shows the selected file before submit

Good next steps if you want to turn this into a production-ready Submittable alternative:

1. add authentication and role-based reviewer access
2. move submissions into a real database
3. support file uploads instead of attachment name placeholders
4. add forms builder, payment integration, and email notifications
5. split public submitter and internal reviewer views into separate routes
