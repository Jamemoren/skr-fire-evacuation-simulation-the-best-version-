interface StoredModel {
  id: "current";
  name: string;
  size: number;
  lastModified: number;
  sha256: string;
  blob: Blob;
}

const DB_NAME = "skr-building1-digital-twin";
const STORE_NAME = "model-files";
const DB_VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("เปิด IndexedDB ไม่สำเร็จ"));
  });
}

export async function saveModelFile(
  file: File,
  sha256: string,
): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({
      id: "current",
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      sha256,
      blob: file,
    } satisfies StoredModel);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("บันทึกไฟล์ไม่สำเร็จ"));
  });
  database.close();
}

export async function loadModelFile(): Promise<StoredModel | null> {
  const database = await openDatabase();
  const result = await new Promise<StoredModel | null>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get("current");
    request.onsuccess = () => resolve((request.result as StoredModel | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("อ่านไฟล์ไม่สำเร็จ"));
  });
  database.close();
  return result;
}

export async function clearModelFile(): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete("current");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("ลบไฟล์ไม่สำเร็จ"));
  });
  database.close();
}
