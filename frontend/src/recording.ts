/** Synchronous guard for a single in-flight scoring mutation. */
export function createRecordingLock() {
  let locked = false;
  return {
    acquire() {
      if (locked) return false;
      locked = true;
      return true;
    },
    release() { locked = false; },
    get isLocked() { return locked; },
  };
}

/** Any transport failure without an HTTP response is ambiguous and may queue. */
export function shouldQueueOffline(online: boolean, httpStatus?: number) {
  void online; // navigator.onLine is advisory and may remain true during a broken transport.
  return httpStatus === undefined;
}
