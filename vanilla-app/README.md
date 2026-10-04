# Vanilla JS Podcast TTS

This is a backend-free version of the podcast workflow.

## Features

- Import `.txt` and `.docx` scripts in browser
- Manual line editing and insertion
- Generate audio via provider APIs using `fetch`
- Merge generated lines into one WAV in browser (Web Audio API)
- Play or download merged output

## Run

Use any static server from the project root.

### Option A: VS Code Live Server

Open `vanilla-app/index.html` with Live Server.

### Option B: Node static server

```bash
npx serve vanilla-app
```

Then open the shown URL (commonly `http://localhost:3000`).

## Notes

- Provider settings are saved in localStorage.
- API keys are stored in localStorage in encrypted form.
- Uploaded jingle files are stored as blobs in IndexedDB so they persist across reloads.
- Bundled jingles live under `./jingles/` and are available by default.

## Script Parsing

- `V1: line text` -> speaker V1
- `V2: line text` -> speaker V2
- `#1#` or `#J1#` -> jingle 1
- `#2#` or `#J2#` -> jingle 2
- jingle markers ignore the rest of the line and fall back to the first jingle when out of range
- plain lines -> default to V1
