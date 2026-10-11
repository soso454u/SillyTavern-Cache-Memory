// Large recovery data belongs in IndexedDB, not the small synchronous Web
// Storage quota shared with SillyTavern and every other extension.
export class LocalMemoryStorage {
    constructor(indexedDB = globalThis.indexedDB) { this.indexedDB = indexedDB; }

    open() {
        if (!this.database) this.database = new Promise((resolve, reject) => {
            const request = this.indexedDB.open('cache-memory-recovery-v1', 1);
            const timer = setTimeout(() => reject(new Error('本机记忆存储打开超时')), 5000);
            request.onupgradeneeded = () => request.result.createObjectStore('records');
            request.onerror = () => { clearTimeout(timer); reject(request.error); };
            request.onblocked = () => { clearTimeout(timer); reject(new Error('本机记忆存储被其他页面阻塞')); };
            request.onsuccess = () => {
                clearTimeout(timer);
                request.result.onversionchange = () => { request.result.close(); this.database = null; };
                resolve(request.result);
            };
        }).catch(error => { this.database = null; throw error; });
        return this.database;
    }

    async transaction(mode, operation) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('records', mode);
            const request = operation(tx.objectStore('records'));
            // Request success alone does not mean the transaction was committed.
            tx.oncomplete = () => resolve(request.result);
            tx.onerror = tx.onabort = () => reject(tx.error || request.error || new Error('本机记忆存储提交失败'));
        });
    }

    read(key) { return this.transaction('readonly', store => store.get(key)); }
    write(key, value) { return this.transaction('readwrite', store => store.put(value, key)); }
    remove(key) { return this.transaction('readwrite', store => store.delete(key)); }
}
