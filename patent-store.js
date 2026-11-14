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

  async function erase(app) {
    const db = await open();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(['cases', 'files'], 'readwrite');
      const cases = transaction.objectStore('cases');
      const files = transaction.objectStore('files');
      if (app) {
        cases.delete(app);
        files.delete(IDBKeyRange.bound([app], [app, []]));
      } else {
        cases.clear();
        files.clear();
      }
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
    });
  }

  return { remove: erase, clear: () => erase(null) };
})();
