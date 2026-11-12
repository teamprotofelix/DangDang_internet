// Keep patent records and PDF bytes local and out of conversation exports.
const PatentStore = (() => {
  let database;
  function open() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open('dangdang-patent-diagnosis', 2);
      request.onupgradeneeded = event => {
        if (event.oldVersion < 1) request.result.createObjectStore('cases');
        if (event.oldVersion < 2) request.result.createObjectStore('files');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(error => { database = null; throw error; });
    return database;
  }

  async function operation(mode, act, name = 'cases') {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(name, mode);
      const request = act(transaction.objectStore(name));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  return {
    get: id => operation('readonly', store => store.get(id)),
    save: record => operation('readwrite', store => store.put(record, record.application)),
    file: (app, id) => operation('readonly', store => store.get([app, id]), 'files'),
    async saveWithFile(record, id, bytes, removeIds = []) {
      const db = await open();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(['cases', 'files'], 'readwrite');
        transaction.objectStore('cases').put(record, record.application);
        const files = transaction.objectStore('files');
        for (const removeId of removeIds) files.delete([record.application, removeId]);
        if (id !== null) files.put(bytes, [record.application, id]);
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error);
      });
    },
    async remove(app) {
      const db = await open();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(['cases', 'files'], 'readwrite');
        transaction.objectStore('cases').delete(app);
        transaction.objectStore('files').delete(IDBKeyRange.bound([app], [app, []]));
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error);
      });
    }
  };
})();
