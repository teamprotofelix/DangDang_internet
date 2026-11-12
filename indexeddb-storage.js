// ============================================================
// indexeddb-storage.js — IndexedDB 기반 대용량 대화 저장소
// 사실상 무제한 저장 가능 (디스크 용량의 ~60%까지)
// ============================================================

const DB_NAME = 'HaruAvatarDB';
const DB_VERSION = 2;
const STORE_NAME = 'conversations';
const LEGACY_ARCHIVE_STORE = 'archives';

class IndexedDBStorage {
  constructor() {
    this.db = null;
    this.dbReady = this.initDB();
  }

  /**
   * IndexedDB 초기화
   */
  initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const tx = event.target.transaction;

        // 대화 메시지 저장소
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('role', 'role', { unique: false });
        }

        // v1 아카이브 → 살아 있는 대화로 되돌린 뒤 보관함 제거
        if (db.objectStoreNames.contains(LEGACY_ARCHIVE_STORE)) {
          const archiveStore = tx.objectStore(LEGACY_ARCHIVE_STORE);
          const convStore = tx.objectStore(STORE_NAME);
          archiveStore.openCursor().onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) {
              db.deleteObjectStore(LEGACY_ARCHIVE_STORE);
              return;
            }
            const entry = cursor.value;
            if (entry && Array.isArray(entry.messages)) {
              for (const msg of entry.messages) {
                if (msg && msg.id) convStore.put(msg);
              }
            }
            cursor.continue();
          };
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        console.log('[IndexedDB] 저장소 초기화 완료');
        resolve(this.db);
      };

      request.onerror = (event) => {
        console.error('[IndexedDB] 초기화 실패:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  async ensureDB() {
    if (!this.db) await this.dbReady;
    return this.db;
  }

  // ============================================================
  // 메시지 CRUD
  // ============================================================

  /**
   * 메시지 추가
   */
  async addMessage(message, { isCurrent = () => true } = {}) {
    const db = await this.ensureDB();
    // DB initialization may wait behind other work. Check in the same turn as
    // issuing the native write, so a stale automatic reply never enters it.
    if (!isCurrent()) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.add(message);

      request.onsuccess = () => resolve(message);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 모든 메시지 가져오기 (시간순)
   * @param {number} limit 최대 개수
   * @param {number} offset 건너뛸 개수
   */
  async getMessages(limit = 100, offset = 0) {
    const db = await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('timestamp');

      const messages = [];
      index.openCursor(null, 'next').onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) {
          resolve(messages);
          return;
        }

        if (offset > 0) {
          offset--;
          cursor.continue();
          return;
        }

        messages.push(cursor.value);

        if (messages.length >= limit) {
          resolve(messages);
          return;
        }

        cursor.continue();
      };

      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * 최근 N개 메시지 가져오기
   */
  async getRecentMessages(count = 200) {
    const db = await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('timestamp');

      const messages = [];
      // 역순으로 가져와서 최근 것부터
      index.openCursor(null, 'prev').onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor || messages.length >= count) {
          resolve(messages.reverse()); // 시간순 정렬
          return;
        }
        messages.push(cursor.value);
        cursor.continue();
      };

      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * 메시지 하나 삭제 (초기화 epoch 불일치 시 되돌리기용)
   */
  async deleteMessage(id) {
    const db = await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 모든 메시지 삭제
   */
  async clearAll() {
    const db = await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 전체 메시지 개수
   */
  async getCount() {
    const db = await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 총 저장 용량 추정 (bytes)
   */
  async getEstimatedSize() {
    const messages = await this.getMessages(999999);
    const json = JSON.stringify(messages);
    return new Blob([json]).size;
  }

  // ============================================================
  // JSON 파일 내보내기 / 가져오기
  // ============================================================

  /**
   * 모든 대화를 JSON 파일로 내보내기 (다운로드)
   */
  async exportToFile(filename = null) {
    const messages = await this.getMessages(999999);

    const exportData = {
      version: '1.0',
      exportedAt: nowISO(),
      character: '댕댕이 (Dangdang-i)',
      messageCount: messages.length,
      messages: messages
    };

    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const dateStr = new Date().toISOString().slice(0, 10);
    const defaultFilename = filename || `댕댕이_대화백업_${dateStr}.json`;

    // 다운로드 트리거
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultFilename;
    a.click();
    URL.revokeObjectURL(url);

    return defaultFilename;
  }

  /**
   * JSON 파일에서 대화 가져오기
   * @param {File} file 업로드된 JSON 파일
   */
  async importFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = async (e) => {
        try {
          const data = JSON.parse(e.target.result);

          if (!data.messages || !Array.isArray(data.messages)) {
            throw new Error('올바른 백업 파일이 아닙니다');
          }

          const db = await this.ensureDB();
          const tx = db.transaction([STORE_NAME], 'readwrite');
          const store = tx.objectStore(STORE_NAME);

          const incoming = [...data.messages];
          if (Array.isArray(data.archives)) {
            for (const archive of data.archives) {
              if (archive && Array.isArray(archive.messages)) {
                incoming.push(...archive.messages);
              }
            }
          }

          let imported = 0;
          incoming.forEach(msg => {
            if (!msg || !msg.id) return;
            store.put(msg);
            imported++;
          });

          await new Promise((res, rej) => {
            tx.oncomplete = res;
            tx.onerror = rej;
          });

          resolve({ imported });
        } catch (err) {
          reject(err);
        }
      };

      reader.onerror = () => reject(new Error('파일을 읽을 수 없습니다'));
      reader.readAsText(file);
    });
  }

  /**
   * 용량 정보 가져오기
   */
  async getStorageInfo() {
    const count = await this.getCount();
    const estimatedBytes = await this.getEstimatedSize();

    return {
      messageCount: count,
      totalMessagesEver: count,
      estimatedSizeKB: Math.round(estimatedBytes / 1024),
      estimatedSizeMB: (estimatedBytes / (1024 * 1024)).toFixed(2)
    };
  }
}

// --- 전역 인스턴스 ---
const idbStorage = new IndexedDBStorage();
const indexedDBStorage = idbStorage;
