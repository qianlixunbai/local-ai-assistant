/* Development-only Chrome protocol connection; never log protocol payloads. */
class CDP {
  constructor(socket) {
    this.socket = socket; this.nextId = 0; this.pending = new Map(); this.listeners = new Map();
    socket.addEventListener("message", event => {
      const packet = JSON.parse(event.data);
      if (packet.id) {
        const entry = this.pending.get(packet.id);
        if (!entry) return;
        this.pending.delete(packet.id); clearTimeout(entry.timer);
        if (packet.error) {
          const error = new Error("Chrome protocol command rejected: " + entry.method);
          // Only this non-sensitive browser action diagnostic is available to the integration runner.
          if (entry.method === "Extensions.triggerAction") error.actionDiagnostic = packet.error.message;
          entry.reject(error);
        }
        else entry.resolve(packet.result);
      } else for (const fn of this.listeners.get(packet.method) || []) fn(packet.params);
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", () => reject(new Error("Chrome protocol unavailable")), { once: true }); });
    return new CDP(socket);
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Chrome command deadline: " + method)); }, 15000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) { this.listeners.set(method, [...(this.listeners.get(method) || []), fn]); }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error("Chrome evaluation failed (details suppressed)");
    return result.result.value;
  }
  close() { this.socket.close(); }
}
module.exports = { CDP };
