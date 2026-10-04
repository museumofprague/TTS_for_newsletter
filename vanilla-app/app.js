// ========= App Constants and Defaults ============================================================================
const STORAGE_KEY_SETTINGS = "podcastTts.settings.v1";
const STORAGE_KEY_API_KEY = "podcastTts.apiKey.v1";
const API_KEY_PASSWORD = "ttspodcast";
const DB_NAME = "podcastTtsDB";
const DB_VERSION = 1;
const JINGLE_STORE = "jingles";

const DEFAULT_JINGLES = [
  { id: "builtin-jingle", name: "Jingle", value: "./jingles/jingle.wav", sourceType: "bundled" },
  { id: "builtin-wingrandpiano", name: "Grand Piano", value: "./jingles/wingrandpiano.wav", sourceType: "bundled" },
  { id: "builtin-winfretless", name: "Fretless", value: "./jingles/winfretless.wav", sourceType: "bundled" },
];

const DEFAULT_SETTINGS = {
  provider: "elevenlabs",
  apiKey: "",
  languageCode: "",
  openaiModel: "gpt-4o-mini-tts",
  voices: {
    elevenlabs: [
      { name: "Bill Oxley", value: "T5cu6IU92Krx4mh43osx" },
      { name: "Verity X", value: "1hlpeD1ydbI2ow0Tt3EW" },
    ],
    openai: [
      {
        name: "alloy",
        value: "Voice Affect: Calm, composed, and reassuring. Competent and in control, instilling trust. Tone: Sincere, empathetic, with genuine concern for the customer and understanding of the situation. Pacing: Slower during the apology to allow for clarity and processing. Faster when offering solutions to signal action and resolution. Emotions: Calm reassurance, empathy, and gratitude. Pronunciation: Clear, precise: Ensures clarity, especially with key details. Focus on key words like 'refund' and 'patience.'",
      },
      {
        name: "ash",
        value: "Affect/personality: A cheerful guide. Tone: Friendly, clear, and reassuring, creating a calm atmosphere and making the listener feel confident and comfortable. Pronunciation: Clear, articulate, and steady, ensuring each instruction is easily understood while maintaining a natural, conversational flow. Pause: Brief, purposeful pauses after key instructions (e.g., 'cross the street' and 'turn right') to allow time for the listener to process the information and follow along. Emotion: Warm and supportive, conveying empathy and care, ensuring the listener feels guided and safe throughout the journey.",
      },
    ],
  },
  jingles: DEFAULT_JINGLES.map((jingle) => ({ ...jingle })),
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  jingleBlobCache: new Map(),
  bubbles: [],
  mergedBlob: null,
  generating: false,
};

const el = {
  provider: document.getElementById("providerSelect"),
  apiKey: document.getElementById("apiKeyInput"),
  languageCode: document.getElementById("languageCodeInput"),
  openaiModel: document.getElementById("openaiModelSelect"),
  elevenFields: document.getElementById("elevenlabsFields"),
  openaiFields: document.getElementById("openaiFields"),
  voicesList: document.getElementById("voicesList"),
  addVoiceBtn: document.getElementById("addVoiceBtn"),
  voiceHint: document.getElementById("voiceHint"),
  jinglesList: document.getElementById("jinglesList"),
  addJingleBtn: document.getElementById("addJingleBtn"),
  jingleHint: document.getElementById("jingleHint"),
  jingleSelect: document.getElementById("jingleSelect"),
  jingleFileInput: document.getElementById("jingleFileInput"),
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("fileInput"),
  chooseFileBtn: document.getElementById("chooseFileBtn"),
  speakerSelect: document.getElementById("speakerSelect"),
  lineTextInput: document.getElementById("lineTextInput"),
  addLineBtn: document.getElementById("addLineBtn"),
  insertPosition: document.getElementById("insertPositionSelect"),
  generateAllBtn: document.getElementById("generateAllBtn"),
  playMergedBtn: document.getElementById("playMergedBtn"),
  downloadMergedBtn: document.getElementById("downloadMergedBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  bubbleList: document.getElementById("bubbleList"),
  countText: document.getElementById("countText"),
  status: document.getElementById("statusText"),
  progressBar: document.getElementById("progressBar"),
  scrollTopBtn: document.getElementById("scrollTopBtn"),
  player: document.getElementById("player"),
};

// ========= Crypto Helpers ============================================================================
function bytesToBase64(bytes) {
  const chars = [];
  for (let i = 0; i < bytes.length; i += 1) {
    chars.push(String.fromCharCode(bytes[i]));
  }
  return btoa(chars.join(""));
}

function base64ToBytes(value) {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

async function deriveAesKey(password, salt) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 120000,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptApiKey(value) {
  if (!value) return "";
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(API_KEY_PASSWORD, salt);
  const encoded = new TextEncoder().encode(value);
  const cipherBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const cipher = new Uint8Array(cipherBuffer);
  return JSON.stringify({
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    cipher: bytesToBase64(cipher),
  });
}

async function decryptApiKey(encryptedPayload) {
  if (!encryptedPayload) return "";
  const parsed = JSON.parse(encryptedPayload);
  const salt = base64ToBytes(parsed.salt);
  const iv = base64ToBytes(parsed.iv);
  const cipher = base64ToBytes(parsed.cipher);
  const key = await deriveAesKey(API_KEY_PASSWORD, salt);
  const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(plainBuffer);
}

// ========= IndexedDB Jingle Storage ============================================================================
let jingleDbPromise = null;

function openJingleDatabase() {
  if (jingleDbPromise) return jingleDbPromise;

  jingleDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(JINGLE_STORE)) {
        db.createObjectStore(JINGLE_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return jingleDbPromise;
}

async function withJingleStore(mode, action) {
  const db = await openJingleDatabase();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(JINGLE_STORE, mode);
    const store = tx.objectStore(JINGLE_STORE);
    Promise.resolve(action(store, tx, resolve, reject)).catch(reject);
    tx.onerror = () => reject(tx.error);
  });
}

async function putJingleBlob(id, blob, meta = {}) {
  await withJingleStore("readwrite", (store, tx, resolve, reject) => {
    const request = store.put({
      id,
      blob,
      mimeType: blob.type || meta.mimeType || "audio/wav",
      size: blob.size ?? meta.size ?? 0,
      updatedAt: Date.now(),
    });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function getJingleBlob(id) {
  return await withJingleStore("readonly", (store, tx, resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function deleteJingleBlob(id) {
  await withJingleStore("readwrite", (store, tx, resolve, reject) => {
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function restoreJingleBlobCache() {
  state.jingleBlobCache.clear();
  for (const jingle of getJingles()) {
    if (jingle.sourceType !== "uploaded") continue;
    const stored = await getJingleBlob(jingle.id).catch(() => null);
    if (stored?.blob) {
      state.jingleBlobCache.set(jingle.id, stored.blob);
    }
  }
}

// ========= Settings and Storage ============================================================================
function applySettingsToInputs() {
  el.provider.value = state.settings.provider;
  el.apiKey.value = state.settings.apiKey;
  el.languageCode.value = state.settings.languageCode;
  el.openaiModel.value = state.settings.openaiModel;
}

function cloneDefaultVoices() {
  return {
    elevenlabs: DEFAULT_SETTINGS.voices.elevenlabs.map((voice) => ({ ...voice })),
    openai: DEFAULT_SETTINGS.voices.openai.map((voice) => ({ ...voice })),
  };
}

function cloneDefaultJingles() {
  return DEFAULT_JINGLES.map((jingle) => ({ ...jingle }));
}

function sanitizeVoices(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  return raw
    .map((voice) => ({
      name: String(voice?.name || "").trim(),
      value: String(voice?.value || "").trim(),
    }))
    .filter((voice) => voice.name || voice.value);
}

function sanitizeJingles(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];

  return raw
    .map((jingle) => ({
      id: String(jingle?.id || uid()).trim(),
      name: String(jingle?.name || "").trim(),
      value: String(jingle?.value || "").trim(),
      sourceType: jingle?.sourceType === "uploaded" ? "uploaded" : "bundled",
      mimeType: String(jingle?.mimeType || "").trim(),
      size: Number(jingle?.size || 0) || 0,
    }))
    .filter((jingle) => jingle.name || jingle.value);
}

function getVoices(provider = state.settings.provider) {
  return state.settings.voices[provider] || [];
}

function getJingles() {
  return state.settings.jingles || [];
}

function getJingleById(jingleId) {
  return getJingles().find((jingle) => jingle.id === jingleId) || null;
}

function getAvailableJingle() {
  const jingles = getJingles();
  return jingles[0] || null;
}

function getJingleByOrdinal(ordinal) {
  const index = Math.max(1, Number(ordinal) || 1) - 1;
  return getJingles()[index] || getAvailableJingle() || null;
}

function getJingleCandidates(preferredJingleId) {
  const jingles = getJingles();
  const preferred = getJingleById(preferredJingleId);
  if (!preferred) return jingles;
  return [preferred, ...jingles.filter((jingle) => jingle.id !== preferred.id)];
}

function getJingleLabel(jingle) {
  if (!jingle) return "None";
  return jingle.name || jingle.value || "Untitled jingle";
}

function getJingleDisplayLabel(jingleId) {
  const jingle = getJingleById(jingleId) || getAvailableJingle();
  return getJingleLabel(jingle);
}

function mergeDefaultJingles(savedJingles) {
  const savedById = new Map(sanitizeJingles(savedJingles).map((jingle) => [jingle.id, jingle]));
  const merged = cloneDefaultJingles().map((defaults) => ({
    ...defaults,
    ...(savedById.get(defaults.id) || {}),
    sourceType: "bundled",
  }));

  for (const saved of savedById.values()) {
    if (!DEFAULT_JINGLES.some((defaults) => defaults.id === saved.id)) {
      merged.push(saved);
    }
  }

  return merged;
}

function ensureJingleCollections() {
  if (!Array.isArray(state.settings.jingles)) {
    state.settings.jingles = cloneDefaultJingles();
    return;
  }

  state.settings.jingles = sanitizeJingles(state.settings.jingles);
}

function ensureVoiceCollections() {
  if (!state.settings.voices || typeof state.settings.voices !== "object") {
    state.settings.voices = cloneDefaultVoices();
  }

  if (!Array.isArray(state.settings.voices.elevenlabs) || !state.settings.voices.elevenlabs.length) {
    state.settings.voices.elevenlabs = cloneDefaultVoices().elevenlabs;
  }

  if (!Array.isArray(state.settings.voices.openai) || !state.settings.voices.openai.length) {
    state.settings.voices.openai = cloneDefaultVoices().openai;
  }
}

function ensureSettingsCollections() {
  ensureVoiceCollections();
  ensureJingleCollections();
}

function getVoicePlaceholders(provider) {
  if (provider === "openai") {
    return {
      name: "Voice name, e.g. alloy",
      value: "Instructions/style guidance for this voice",
      hint: "For OpenAI, name = voice and value = instructions.",
    };
  }

  return {
    name: "Display name, e.g. Bill Oxley",
    value: "ElevenLabs voice ID",
    hint: "For ElevenLabs, name = label and value = voice ID.",
  };
}

function getJinglePlaceholders() {
  return {
    name: "Jingle name",
    value: "File name or path",
    hint: "Upload audio files; stored blobs live in IndexedDB.",
  };
}

function renderSpeakerOptions() {
  const activeVoices = getVoices();
  const options = [];

  activeVoices.forEach((voice, index) => {
    const label = voice.name || `Voice ${index + 1}`;
    options.push(`<option value="${index + 1}">V${index + 1} - ${escapeHtml(label)}</option>`);
  });

  if (!options.length) {
    options.push("<option value=\"1\">V1</option>");
  }

  const currentValue = Number(el.speakerSelect.value) || 1;
  el.speakerSelect.innerHTML = options.join("");
  const max = Math.max(1, activeVoices.length);
  const nextValue = Math.min(currentValue, max);
  el.speakerSelect.value = String(nextValue);
}

function renderJingleOptions() {
  if (!el.jingleSelect) return;

  const jingles = getJingles();
  const options = ['<option value="">None</option>'];

  jingles.forEach((jingle, index) => {
    options.push(`<option value="${jingle.id}">J${index + 1} - ${escapeHtml(getJingleLabel(jingle))}</option>`);
  });

  const currentValue = el.jingleSelect.value || "";
  el.jingleSelect.innerHTML = options.join("");
  if (jingles.some((jingle) => jingle.id === currentValue)) {
    el.jingleSelect.value = currentValue;
  } else {
    el.jingleSelect.value = "";
  }
}

function renderBubbleJingleOptions(selectedJingleId) {
  const jingles = getJingles();
  const options = ['<option value="">None</option>'];

  jingles.forEach((jingle, index) => {
    options.push(`<option value="${jingle.id}" ${selectedJingleId === jingle.id ? "selected" : ""}>J${index + 1} - ${escapeHtml(getJingleLabel(jingle))}</option>`);
  });

  return options.join("");
}

function renderVoicesEditor() {
  if (!el.voiceHint || !el.voicesList || !el.addVoiceBtn) {
    return;
  }

  ensureVoiceCollections();
  const provider = state.settings.provider;
  const voices = getVoices(provider);
  const placeholders = getVoicePlaceholders(provider);

  el.voiceHint.textContent = placeholders.hint;
  el.voicesList.innerHTML = voices.map((voice, index) => {
    return `
      <div class="voice-row" data-index="${index}">
        <input data-action="voice-name" data-index="${index}" placeholder="${escapeHtml(placeholders.name)}" value="${escapeHtml(voice.name)}">
        <input data-action="voice-value" data-index="${index}" placeholder="${escapeHtml(placeholders.value)}" value="${escapeHtml(voice.value)}">
        <button type="button" data-action="delete-voice" data-index="${index}" class="ghost">Delete</button>
      </div>
    `;
  }).join("");

  renderSpeakerOptions();
}

async function renderJinglesEditor() {
  if (!el.jingleHint || !el.jinglesList || !el.addJingleBtn) {
    return;
  }

  const jingles = getJingles();
  const placeholders = getJinglePlaceholders();

  el.jingleHint.textContent = placeholders.hint;
  el.jinglesList.innerHTML = jingles.map((jingle, index) => {
    const sourceLabel = jingle.sourceType === "uploaded" ? "Uploaded" : "Bundled";
    return `
      <div class="voice-row jingle-row" data-index="${index}">
        <input data-action="jingle-name" data-index="${index}" placeholder="${escapeHtml(placeholders.name)}" value="${escapeHtml(jingle.name)}">
        <input data-action="jingle-value" data-index="${index}" placeholder="${escapeHtml(placeholders.value)}" value="${escapeHtml(jingle.value)}">
        <span class="jingle-badge">${escapeHtml(sourceLabel)}</span>
        <button type="button" data-action="replace-jingle" data-index="${index}" class="ghost">Upload</button>
        <button type="button" data-action="delete-jingle" data-index="${index}" class="ghost">Delete</button>
      </div>
    `;
  }).join("");

  renderJingleOptions();
}

async function loadSettingsFromStorage() {
  const loaded = { ...DEFAULT_SETTINGS };

  try {
    const rawSettings = localStorage.getItem(STORAGE_KEY_SETTINGS);
    if (rawSettings) {
      const parsed = JSON.parse(rawSettings);
      loaded.provider = parsed.provider || loaded.provider;
      loaded.languageCode = parsed.languageCode || "";
      loaded.openaiModel = parsed.openaiModel || loaded.openaiModel;
      loaded.voices = parsed.voices && typeof parsed.voices === "object"
        ? {
          elevenlabs: sanitizeVoices(parsed.voices.elevenlabs),
          openai: sanitizeVoices(parsed.voices.openai),
        }
        : cloneDefaultVoices();

      loaded.jingles = Object.prototype.hasOwnProperty.call(parsed, "jingles")
        ? sanitizeJingles(parsed.jingles)
        : cloneDefaultJingles();

      if (!parsed.voices || typeof parsed.voices !== "object") {
        // Backward compatibility for old fixed voice fields.
        if (parsed.elevenVoice1) {
          loaded.voices.elevenlabs[0].value = String(parsed.elevenVoice1);
        }
        if (parsed.elevenVoice2) {
          loaded.voices.elevenlabs[1] = {
            ...loaded.voices.elevenlabs[1],
            value: String(parsed.elevenVoice2),
          };
        }
        if (parsed.openaiVoice1) {
          loaded.voices.openai[0].name = String(parsed.openaiVoice1);
        }
        if (parsed.openaiVoice2) {
          loaded.voices.openai[1] = {
            ...loaded.voices.openai[1],
            name: String(parsed.openaiVoice2),
          };
        }
        if (parsed.openaiInst1) {
          loaded.voices.openai[0].value = String(parsed.openaiInst1);
        }
        if (parsed.openaiInst2) {
          loaded.voices.openai[1] = {
            ...loaded.voices.openai[1],
            value: String(parsed.openaiInst2),
          };
        }
      }
    }
  } catch {
    // Corrupt settings are ignored and defaults are used.
  }

  try {
    const encryptedKey = localStorage.getItem(STORAGE_KEY_API_KEY);
    loaded.apiKey = encryptedKey ? await decryptApiKey(encryptedKey) : "";
  } catch {
    loaded.apiKey = "";
  }

  state.settings = loaded;
  ensureSettingsCollections();
}

async function saveSettingsToStorage() {
  const safeSettings = {
    provider: state.settings.provider,
    languageCode: state.settings.languageCode,
    openaiModel: state.settings.openaiModel,
    voices: {
      elevenlabs: sanitizeVoices(state.settings.voices.elevenlabs),
      openai: sanitizeVoices(state.settings.voices.openai),
    },
    jingles: sanitizeJingles(state.settings.jingles),
  };

  localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(safeSettings));

  if (state.settings.apiKey) {
    const encrypted = await encryptApiKey(state.settings.apiKey);
    localStorage.setItem(STORAGE_KEY_API_KEY, encrypted);
  } else {
    localStorage.removeItem(STORAGE_KEY_API_KEY);
  }
}

function persistSettingsSoon() {
  saveSettingsToStorage().catch(() => {
    setStatus("Failed to save settings");
  });
}

function syncJingleCollections() {
  ensureSettingsCollections();
  renderJingleOptions();
}

function logout() {
  localStorage.removeItem(STORAGE_KEY_API_KEY);
  state.settings.apiKey = "";
  el.apiKey.value = "";
  syncSettingsFromInputs();
  setStatus("Logged out. Stored API key removed.");
}

// ========= Generic UI Helpers ============================================================================
function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function setStatus(text) {
  el.status.textContent = text;
}

function setProgress(done, total) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  el.progressBar.style.width = `${percent}%`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function syncSettingsFromInputs() {
  state.settings.provider = el.provider.value;
  state.settings.apiKey = el.apiKey.value.trim();
  state.settings.languageCode = el.languageCode.value.trim();
  state.settings.openaiModel = el.openaiModel.value;
}

function updateProviderFields() {
  const isEleven = el.provider.value === "elevenlabs";
  el.elevenFields.classList.toggle("hidden", !isEleven);
  el.openaiFields.classList.toggle("hidden", isEleven);
}

function refreshInsertOptions() {
  const options = ["<option value=\"\">Append to end</option>"];
  state.bubbles.forEach((bubble, index) => {
    options.push(`<option value=\"${index + 1}\">After #${index + 1} - ${escapeHtml(bubble.text.slice(0, 38))}</option>`);
  });
  el.insertPosition.innerHTML = options.join("");
}

// ========= Rendering ============================================================================
function renderBubbles() {
  const activeVoiceCount = getVoices().length;

  el.countText.textContent = `${state.bubbles.length} lines`;
  el.bubbleList.innerHTML = state.bubbles.map((bubble, index) => {
    const errorClass = bubble.error ? "error" : "";
    const status = bubble.status || "pending";
    const playable = bubble.audioBlob ? "" : "disabled";
    const voiceOptions = Array.from({ length: Math.max(activeVoiceCount, 1) }, (_, i) => {
      const voice = getVoices()[i];
      const label = voice?.name || `Voice ${i + 1}`;
      return `<option value="${i + 1}" ${bubble.voiceNumber === i + 1 ? "selected" : ""}>V${i + 1} - ${escapeHtml(label)}</option>`;
    }).join("");
    const voiceDisabled = bubble.jingleId ? "disabled" : "";
    const bubbleTypeLabel = bubble.jingleId
      ? `Jingle - ${escapeHtml(getJingleDisplayLabel(bubble.jingleId))}`
      : `V${bubble.voiceNumber}`;

    const fallbackLabel = bubble.voiceNumber > Math.max(activeVoiceCount, 1)
      ? ` (fallback to V1)`
      : "";

    return `
      <article class="bubble ${bubble.jingleId ? "jingle" : bubble.voiceNumber % 2 === 0 ? "v2" : "v1"}" data-id="${bubble.id}">
        <div class="bubble-head">
          <strong>#${index + 1} - ${bubbleTypeLabel}${fallbackLabel}</strong>
          <div class="bubble-actions">
            <select data-action="jingle" data-id="${bubble.id}">${renderBubbleJingleOptions(bubble.jingleId)}</select>
            <select data-action="voice" data-id="${bubble.id}" ${voiceDisabled}>${voiceOptions}</select>
            <button data-action="generate" data-id="${bubble.id}">Generate</button>
            <button data-action="play" data-id="${bubble.id}" ${playable}>Play</button>
            <button data-action="delete" data-id="${bubble.id}">Delete</button>
          </div>
        </div>
        ${bubble.jingleId ? `<div class="meta">Uses jingle: ${escapeHtml(getJingleDisplayLabel(bubble.jingleId))}</div>` : `<textarea data-action="text" data-id="${bubble.id}" rows="3">${escapeHtml(bubble.text)}</textarea>`}
        <div class="meta ${errorClass}">${escapeHtml(status)} ${bubble.error ? `- ${escapeHtml(bubble.error)}` : ""}</div>
      </article>
    `;
  }).join("");

  refreshInsertOptions();
}

function wireScrollTopButton() {
  if (!el.scrollTopBtn) return;

  el.scrollTopBtn.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  const hero = document.getElementById("heroSection");
  if (!hero || typeof IntersectionObserver !== "function") {
    el.scrollTopBtn.classList.remove("hidden");
    return;
  }

  const observer = new IntersectionObserver(
    ([entry]) => {
      el.scrollTopBtn.classList.toggle("hidden", entry.isIntersecting);
    },
    { threshold: 0.05 },
  );

  observer.observe(hero);
}

// ========= Script Parsing and Bubble Model ============================================================================
function parseScriptText(rawText) {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line) => {
    const jingleMarker = line.match(/^#(?:J)?(\d+)#(?:\s*(.*))?$/i);
    if (jingleMarker) {
      const jingle = getJingleByOrdinal(jingleMarker[1]);
      return createBubble("", 1, "upload", jingle?.id || "");
    }

    const vx = line.match(/^V(\d+)\s*:\s*(.+)$/i);
    if (vx) {
      const voiceNumber = Math.max(1, Number(vx[1]) || 1);
      return createBubble(vx[2], voiceNumber, "upload");
    }
    return createBubble(line, 1, "upload");
  });
}

function createBubble(text, voiceNumber = 1, source = "manual", jingleId = "") {
  return {
    id: uid(),
    voiceNumber: Math.max(1, Number(voiceNumber) || 1),
    jingleId: jingleId || "",
    text: text.trim(),
    source,
    status: "pending",
    error: "",
    audioBlob: null,
    audioUrl: "",
  };
}

// ========= File Import ============================================================================
async function readTextFromFile(file) {
  if (file.name.toLowerCase().endsWith(".txt")) {
    return await file.text();
  }

  if (file.name.toLowerCase().endsWith(".docx")) {
    if (!window.mammoth) {
      throw new Error("DOCX parser not loaded. Reload page and retry.");
    }
    const buffer = await file.arrayBuffer();
    const result = await window.mammoth.extractRawText({ arrayBuffer: buffer });
    return result.value || "";
  }

  throw new Error("Unsupported file type. Use TXT or DOCX.");
}

async function importFile(file) {
  setStatus(`Importing ${file.name}...`);
  const text = await readTextFromFile(file);
  const bubbles = parseScriptText(text);
  await preloadJingleAudio(bubbles);
  state.bubbles = bubbles;
  state.mergedBlob = null;
  updateMergedButtons();
  renderBubbles();
  if (!bubbles.length) {
    setStatus("Loaded file but no non-empty lines found.");
    return;
  }
  setStatus(`Loaded ${bubbles.length} lines`);
}

let pendingJingleUploadId = "";

function fileBaseName(fileName) {
  return String(fileName || "")
    .replace(/\.[^.]+$/, "")
    .trim() || "Untitled jingle";
}

async function upsertJingleFromFile(file, existingJingleId = "") {
  const blob = file.slice(0, file.size, file.type || "audio/wav");
  const existing = existingJingleId ? getJingleById(existingJingleId) : null;
  const id = existing?.id || uid();
  const name = existing?.name || fileBaseName(file.name);
  const value = file.name || existing?.value || "uploaded file";

  await putJingleBlob(id, blob, { mimeType: blob.type, size: blob.size });
  state.jingleBlobCache.set(id, blob);

  const nextJingle = {
    id,
    name,
    value,
    sourceType: "uploaded",
    mimeType: blob.type || file.type || "audio/wav",
    size: blob.size,
  };

  const current = getJingles();
  const index = current.findIndex((jingle) => jingle.id === id);
  if (index >= 0) {
    const next = [...current];
    next[index] = nextJingle;
    state.settings.jingles = next;
  } else {
    state.settings.jingles = [...current, nextJingle];
  }
  ensureJingleCollections();
  await saveSettingsToStorage();
  await renderJinglesEditor();
  renderBubbles();
  setStatus(existingJingleId ? `Updated jingle ${name}` : `Added jingle ${name}`);
}

async function removeJingle(jingleId) {
  const remaining = getJingles().filter((jingle) => jingle.id !== jingleId);
  if (remaining.length === 0) {
    setStatus("At least one jingle is required.");
    return;
  }

  await deleteJingleBlob(jingleId).catch(() => {});
  state.jingleBlobCache.delete(jingleId);
  state.settings.jingles = remaining;

  const fallback = getAvailableJingle();
  state.bubbles.forEach((bubble) => {
    if (bubble.jingleId === jingleId) {
      bubble.jingleId = fallback?.id || "";
      bubble.status = "pending";
      bubble.error = "";
    }
  });

  await saveSettingsToStorage();
  await renderJinglesEditor();
  renderBubbles();
  setStatus("Jingle deleted");
}

async function onJingleFilePicked(file) {
  if (!file) return;
  await upsertJingleFromFile(file, pendingJingleUploadId);
  pendingJingleUploadId = "";
}
async function preloadJingleAudio(bubbles) {
  const jingleBubbles = bubbles.filter((bubble) => bubble.jingleId);
  for (const bubble of jingleBubbles) {
    try {
      const blob = await resolveJingleBlob(bubble.jingleId);
      revokeBubbleUrl(bubble);
      bubble.audioBlob = blob;
      bubble.audioUrl = URL.createObjectURL(blob);
      bubble.status = "ready";
      bubble.error = "";
    } catch (error) {
      bubble.status = "error";
      bubble.error = error?.message || "Failed to load jingle";
      bubble.audioBlob = null;
      bubble.audioUrl = "";
    }
  }
}

// ========= Bubble Audio State ============================================================================
function updateMergedButtons() {
  const hasMerged = Boolean(state.mergedBlob);
  el.playMergedBtn.disabled = !hasMerged;
  el.downloadMergedBtn.disabled = !hasMerged;
}

function revokeBubbleUrl(bubble) {
  if (bubble.audioUrl) {
    URL.revokeObjectURL(bubble.audioUrl);
    bubble.audioUrl = "";
  }
}

function getBubbleById(id) {
  return state.bubbles.find((item) => item.id === id);
}

async function resolveJingleBlob(jingleId) {
  const candidates = getJingleCandidates(jingleId);
  let lastError = null;

  for (const jingle of candidates) {
    try {
      if (jingle.sourceType === "bundled") {
        const response = await fetch(jingle.value);
        if (!response.ok) {
          throw new Error(`Failed to load bundled jingle: ${jingle.value}`);
        }
        return await response.blob();
      }

      if (state.jingleBlobCache.has(jingle.id)) {
        return state.jingleBlobCache.get(jingle.id);
      }

      const stored = await getJingleBlob(jingle.id);
      if (!stored?.blob) {
        throw new Error(`Missing stored jingle: ${getJingleLabel(jingle)}`);
      }

      state.jingleBlobCache.set(jingle.id, stored.blob);
      return stored.blob;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("No jingle available");
}

// ========= Provider Generation ========
async function generateWithElevenLabs(bubble) {
  const voices = getVoices("elevenlabs");
  const selectedVoice = voices[bubble.voiceNumber - 1] || voices[0];
  const voiceId = selectedVoice?.value || "";
  if (!voiceId) {
    throw new Error(`Missing ElevenLabs voice for V${bubble.voiceNumber}`);
  }

  const query = new URLSearchParams({ output_format: "mp3_44100_128" });
  const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?${query.toString()}`;
  const body = {
    text: bubble.text,
    model_id: "eleven_multilingual_v2",
  };

  if (state.settings.languageCode) {
    body.language_code = state.settings.languageCode;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "xi-api-key": state.settings.apiKey,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs ${response.status}: ${errText.slice(0, 180)}`);
  }

  return await response.blob();
}

async function generateWithOpenAI(bubble) {
  const voices = getVoices("openai");
  const selectedVoice = voices[bubble.voiceNumber - 1] || voices[0];
  const voice = selectedVoice?.name || "";
  const instructions = selectedVoice?.value || "";

  if (!voice) {
    throw new Error(`Missing OpenAI voice name for V${bubble.voiceNumber}`);
  }

  const payload = {
    model: state.settings.openaiModel,
    voice,
    input: bubble.text,
    response_format: "mp3",
  };

  if (instructions) {
    payload.instructions = instructions;
  }

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${state.settings.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI ${response.status}: ${errText.slice(0, 180)}`);
  }

  return await response.blob();
}

async function generateBubble(bubbleId) {
  syncSettingsFromInputs();
  if (!state.settings.apiKey) {
    throw new Error("API key is required");
  }

  const bubble = getBubbleById(bubbleId);
  if (!bubble) {
    throw new Error("Line not found");
  }

  bubble.status = "generating";
  bubble.error = "";
  renderBubbles();

  try {
    const blob = bubble.jingleId
      ? await resolveJingleBlob(bubble.jingleId)
      : state.settings.provider === "openai"
        ? await generateWithOpenAI(bubble)
        : await generateWithElevenLabs(bubble);

    revokeBubbleUrl(bubble);
    bubble.audioBlob = blob;
    bubble.audioUrl = URL.createObjectURL(blob);
    bubble.status = "ready";
    bubble.error = "";
    setStatus(`Generated line ${state.bubbles.indexOf(bubble) + 1}`);
  } catch (error) {
    bubble.status = "error";
    bubble.error = error?.message || "Generation failed";
    throw error;
  } finally {
    renderBubbles();
  }
}

async function generateAll() {
  if (state.generating) return;
  if (!state.bubbles.length) {
    setStatus("Nothing to generate. Import file or add lines first.");
    return;
  }

  syncSettingsFromInputs();
  if (!state.settings.apiKey) {
    setStatus("API key is required");
    return;
  }

  state.generating = true;
  setProgress(0, state.bubbles.length);
  setStatus("Generating...");

  for (let i = 0; i < state.bubbles.length; i += 1) {
    try {
      await generateBubble(state.bubbles[i].id);
    } catch (error) {
      setStatus(error?.message || "Generation error");
    }
    setProgress(i + 1, state.bubbles.length);
  }

  try {
    state.mergedBlob = await mergeAllAudio();
    updateMergedButtons();
    setStatus("Generation finished and merged audio is ready");
  } catch (error) {
    state.mergedBlob = null;
    updateMergedButtons();
    setStatus(error?.message || "Failed to merge audio");
  } finally {
    state.generating = false;
  }
}

// ========= Audio Processing ========
async function decodeBlobToAudioBuffer(ctx, blob) {
  const raw = await blob.arrayBuffer();
  return await ctx.decodeAudioData(raw.slice(0));
}

function interleaveChannels(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const result = new Float32Array(length * channels);

  for (let channel = 0; channel < channels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      result[i * channels + channel] = data[i];
    }
  }
  return result;
}

function encodeWav(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const samples = interleaveChannels(audioBuffer);
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset, text) {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

async function mergeAllAudio() {
  const blobs = state.bubbles
    .filter((bubble) => bubble.audioBlob)
    .map((bubble) => bubble.audioBlob);

  if (!blobs.length) {
    throw new Error("No generated audio found to merge");
  }

  const sampleRate = 44100;
  const decodeCtx = new AudioContext({ sampleRate });
  const buffers = [];
  for (const blob of blobs) {
    buffers.push(await decodeBlobToAudioBuffer(decodeCtx, blob));
  }
  await decodeCtx.close();

  const channels = Math.max(...buffers.map((buffer) => buffer.numberOfChannels));
  const totalFrames = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const offline = new OfflineAudioContext(channels, totalFrames, sampleRate);

  let offsetSeconds = 0;
  for (const buffer of buffers) {
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start(offsetSeconds);
    offsetSeconds += buffer.duration;
  }

  const rendered = await offline.startRendering();
  return encodeWav(rendered);
}

// ========= Playback and Bubble Editing ========
function playMerged() {
  if (!state.mergedBlob) return;
  const url = URL.createObjectURL(state.mergedBlob);
  el.player.src = url;
  el.player.play().catch(() => {});
  el.player.onended = () => URL.revokeObjectURL(url);
}

function downloadMerged() {
  if (!state.mergedBlob) return;
  const url = URL.createObjectURL(state.mergedBlob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "merged_output.wav";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function deleteBubble(id) {
  const bubble = getBubbleById(id);
  if (!bubble) return;
  revokeBubbleUrl(bubble);
  state.bubbles = state.bubbles.filter((item) => item.id !== id);
  renderBubbles();
  setStatus("Line deleted");
}

function updateBubbleText(id, text) {
  const bubble = getBubbleById(id);
  if (!bubble) return;
  bubble.text = text;
  bubble.status = "pending";
  bubble.error = "";
}

async function addLine() {
  const selectedJingleId = el.jingleSelect?.value || "";
  const text = selectedJingleId ? "" : el.lineTextInput.value.trim();
  if (!selectedJingleId && !text) {
    setStatus("Type text before adding a line");
    return;
  }

  const bubble = createBubble(text, Number(el.speakerSelect.value) || 1, "manual", selectedJingleId);
  if (bubble.jingleId) {
    try {
      const blob = await resolveJingleBlob(bubble.jingleId);
      bubble.audioBlob = blob;
      bubble.audioUrl = URL.createObjectURL(blob);
      bubble.status = "ready";
    } catch (error) {
      bubble.status = "error";
      bubble.error = error?.message || "Failed to load jingle";
    }
  }
  const position = el.insertPosition.value ? Number(el.insertPosition.value) : state.bubbles.length;
  state.bubbles.splice(position, 0, bubble);
  el.lineTextInput.value = "";
  renderBubbles();
  setStatus("Line added");
}

// ========= Event Wiring and Initialization ============================================================================
function wireDropzone() {
  el.dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    el.dropzone.classList.add("dragover");
  });

  el.dropzone.addEventListener("dragleave", () => {
    el.dropzone.classList.remove("dragover");
  });

  el.dropzone.addEventListener("drop", async (event) => {
    event.preventDefault();
    el.dropzone.classList.remove("dragover");
    if (event.dataTransfer.files.length) {
      try {
        await importFile(event.dataTransfer.files[0]);
      } catch (error) {
        setStatus(error?.message || "Import failed");
      }
    }
  });
}

function wireEvents() {
  el.provider.addEventListener("change", () => {
    updateProviderFields();
    syncSettingsFromInputs();
    renderVoicesEditor();
    renderJinglesEditor();
    renderBubbles();
    persistSettingsSoon();
  });

  [
    el.apiKey,
    el.languageCode,
    el.openaiModel,
  ].forEach((input) => {
    input.addEventListener("input", () => {
      syncSettingsFromInputs();
      persistSettingsSoon();
    });
  });

  if (el.addVoiceBtn && el.voicesList) {
    el.addVoiceBtn.addEventListener("click", () => {
      const provider = state.settings.provider;
      state.settings.voices[provider].push({ name: "", value: "" });
      renderVoicesEditor();
      renderBubbles();
      persistSettingsSoon();
    });

    el.voicesList.addEventListener("input", (event) => {
      const input = event.target.closest("input[data-action]");
      if (!input) return;

      const provider = state.settings.provider;
      const index = Number(input.dataset.index);
      const voice = state.settings.voices[provider][index];
      if (!voice) return;

      if (input.dataset.action === "voice-name") {
        voice.name = input.value;
      }

      if (input.dataset.action === "voice-value") {
        voice.value = input.value;
      }

      renderSpeakerOptions();
      renderBubbles();
      persistSettingsSoon();
    });

    el.voicesList.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action='delete-voice']");
      if (!button) return;

      const provider = state.settings.provider;
      const index = Number(button.dataset.index);
      if (state.settings.voices[provider].length <= 1) {
        setStatus("At least one voice is required.");
        return;
      }

      state.settings.voices[provider].splice(index, 1);
      renderVoicesEditor();
      renderBubbles();
      persistSettingsSoon();
    });
  }

  if (el.addJingleBtn && el.jingleFileInput) {
    el.addJingleBtn.addEventListener("click", () => {
      pendingJingleUploadId = "";
      el.jingleFileInput.value = "";
      el.jingleFileInput.click();
    });

    el.jingleFileInput.addEventListener("change", async () => {
      const file = el.jingleFileInput.files?.[0];
      if (!file) return;
      try {
        await onJingleFilePicked(file);
      } catch (error) {
        setStatus(error?.message || "Failed to add jingle");
      } finally {
        el.jingleFileInput.value = "";
      }
    });

    el.jinglesList.addEventListener("input", (event) => {
      const input = event.target.closest("input[data-action]");
      if (!input) return;

      const index = Number(input.dataset.index);
      const jingle = getJingles()[index];
      if (!jingle) return;

      if (input.dataset.action === "jingle-name") {
        jingle.name = input.value;
      }

      if (input.dataset.action === "jingle-value") {
        jingle.value = input.value;
      }

      persistSettingsSoon();
      renderJingleOptions();
      renderBubbles();
    });

    el.jinglesList.addEventListener("click", (event) => {
      const uploadButton = event.target.closest("button[data-action='replace-jingle']");
      if (uploadButton) {
        pendingJingleUploadId = getJingles()[Number(uploadButton.dataset.index)]?.id || "";
        el.jingleFileInput.value = "";
        el.jingleFileInput.click();
        return;
      }

      const deleteButton = event.target.closest("button[data-action='delete-jingle']");
      if (!deleteButton) return;

      const jingle = getJingles()[Number(deleteButton.dataset.index)];
      if (!jingle) return;

      removeJingle(jingle.id).catch((error) => setStatus(error?.message || "Failed to delete jingle"));
    });
  }

  el.chooseFileBtn.addEventListener("click", () => el.fileInput.click());
  el.fileInput.addEventListener("change", async () => {
    if (!el.fileInput.files.length) return;
    try {
      await importFile(el.fileInput.files[0]);
    } catch (error) {
      setStatus(error?.message || "Import failed");
    }
  });

  el.addLineBtn.addEventListener("click", addLine);
  el.generateAllBtn.addEventListener("click", () => {
    generateAll().catch((error) => setStatus(error?.message || "Generation failed"));
  });
  el.playMergedBtn.addEventListener("click", playMerged);
  el.downloadMergedBtn.addEventListener("click", downloadMerged);
  el.logoutBtn.addEventListener("click", logout);

  el.bubbleList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const id = button.dataset.id;

    if (action === "delete") {
      deleteBubble(id);
      return;
    }

    if (action === "play") {
      const bubble = getBubbleById(id);
      if (!bubble?.audioUrl) return;
      el.player.src = bubble.audioUrl;
      el.player.play().catch(() => {});
      return;
    }

    if (action === "generate") {
      generateBubble(id).catch((error) => setStatus(error?.message || "Generation failed"));
    }
  });

  el.bubbleList.addEventListener("change", async (event) => {
    const jingleSelect = event.target.closest("select[data-action='jingle']");
    if (jingleSelect) {
      const bubble = getBubbleById(jingleSelect.dataset.id);
      if (!bubble) return;
      bubble.jingleId = jingleSelect.value || "";
      bubble.status = bubble.jingleId ? "loading" : "pending";
      bubble.error = "";

      if (!bubble.jingleId) {
        revokeBubbleUrl(bubble);
        bubble.audioBlob = null;
        renderBubbles();
        return;
      }

      renderBubbles();

      try {
        const jingleBlob = await resolveJingleBlob(bubble.jingleId);
        revokeBubbleUrl(bubble);
        bubble.audioBlob = jingleBlob;
        bubble.audioUrl = URL.createObjectURL(jingleBlob);
        bubble.status = "ready";
        bubble.error = "";
        renderBubbles();
        setStatus(`Playing jingle: ${getJingleDisplayLabel(bubble.jingleId)}`);
        el.player.src = bubble.audioUrl;
        el.player.play().catch(() => {});
      } catch (error) {
        bubble.audioBlob = null;
        bubble.audioUrl = "";
        bubble.status = "error";
        bubble.error = error?.message || "Failed to load jingle";
        renderBubbles();
        setStatus(bubble.error);
      }
      return;
    }

    const voiceSelect = event.target.closest("select[data-action='voice']");
    if (!voiceSelect) return;
    const bubble = getBubbleById(voiceSelect.dataset.id);
    if (!bubble) return;
    bubble.voiceNumber = Math.max(1, Number(voiceSelect.value) || 1);
    bubble.status = "pending";
    bubble.error = "";
    renderBubbles();
  });

  el.bubbleList.addEventListener("input", (event) => {
    const area = event.target.closest("textarea[data-action='text']");
    if (!area) return;
    updateBubbleText(area.dataset.id, area.value);
  });
}

async function initialize() {
  await loadSettingsFromStorage();
  await restoreJingleBlobCache();
  applySettingsToInputs();
  updateProviderFields();
  renderVoicesEditor();
  await renderJinglesEditor();
  syncSettingsFromInputs();
  persistSettingsSoon();
  wireDropzone();
  wireEvents();
  wireScrollTopButton();
  renderBubbles();
  setStatus("Ready. Import a file or add lines.");
}

initialize().catch((error) => {
  setStatus(error?.message || "Failed to initialize app");
});
