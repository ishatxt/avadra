/**
 * Local PDF storage for AVADRA.
 *
 * PDF blobs live in IndexedDB, never in localStorage and never on a server.
 * The metadata is kept in a separate object store so the reader can list local
 * documents without loading every blob into memory.
 */

const DB_NAME = "avadra-library";
const DB_VERSION = 1;
const PDF_STORE = "pdfs";
const META_STORE = "meta";

let dbPromise = null;

export function isStorageAvailable() {
  return typeof indexedDB !== "undefined";
}

function openDb() {
  if (!isStorageAvailable()) {
    return Promise.reject(new Error("IndexedDB is not available in this browser."));
  }

  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PDF_STORE)) {
          db.createObjectStore(PDF_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "id" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open local storage."));
      request.onblocked = () => reject(new Error("Local storage is blocked by another tab."));
    });
  }

  return dbPromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Transaction aborted."));
  });
}

export async function putPdf(id, file, extra = {}) {
  const db = await openDb();
  const transaction = db.transaction([PDF_STORE, META_STORE], "readwrite");
  const pdfStore = transaction.objectStore(PDF_STORE);
  const metaStore = transaction.objectStore(META_STORE);
  const addedAt = new Date().toISOString();

  const meta = {
    id,
    name: extra.name || file.name || "Local PDF",
    size: file.size || 0,
    type: file.type || "application/pdf",
    access: extra.access === "personal" ? "personal" : "local",
    lastModified: file.lastModified || Date.now(),
    addedAt,
  };

  pdfStore.put({ id, blob: file });
  metaStore.put(meta);
  await transactionDone(transaction);
  return { ...meta };
}

export async function getPdf(id) {
  const db = await openDb();
  const transaction = db.transaction([PDF_STORE, META_STORE], "readonly");
  const [record, meta] = await Promise.all([
    requestResult(transaction.objectStore(PDF_STORE).get(id)),
    requestResult(transaction.objectStore(META_STORE).get(id)),
    transactionDone(transaction),
  ]);

  if (!record?.blob) return null;
  return {
    id,
    blob: record.blob,
    name: meta?.name || record.blob.name || "Local PDF",
    size: meta?.size ?? record.blob.size ?? 0,
    type: meta?.type || record.blob.type || "application/pdf",
    access: meta?.access || "local",
    lastModified: meta?.lastModified || record.blob.lastModified || Date.now(),
    addedAt: meta?.addedAt || new Date().toISOString(),
  };
}

export async function getMeta(id) {
  const db = await openDb();
  const transaction = db.transaction(META_STORE, "readonly");
  const meta = await requestResult(transaction.objectStore(META_STORE).get(id));
  return meta || null;
}

export async function listPdfs() {
  const db = await openDb();
  const transaction = db.transaction(META_STORE, "readonly");
  const records = await requestResult(transaction.objectStore(META_STORE).getAll());
  return records
    .map((record) => ({ ...record }))
    .sort((a, b) => Date.parse(b.addedAt || 0) - Date.parse(a.addedAt || 0));
}

export async function deletePdf(id) {
  const db = await openDb();
  const transaction = db.transaction([PDF_STORE, META_STORE], "readwrite");
  transaction.objectStore(PDF_STORE).delete(id);
  transaction.objectStore(META_STORE).delete(id);
  await transactionDone(transaction);
}

export async function clearPdfs() {
  const db = await openDb();
  const transaction = db.transaction([PDF_STORE, META_STORE], "readwrite");
  transaction.objectStore(PDF_STORE).clear();
  transaction.objectStore(META_STORE).clear();
  await transactionDone(transaction);
}

export async function estimateUsage() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}
