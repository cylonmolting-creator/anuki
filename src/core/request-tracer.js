// Request Tracer - implementation for roadmap 10.1
const crypto = require('crypto');

class RequestTracer {
  constructor(logger) {
    this.logger = logger;
    this.traces = new Map();
  }

  startTrace(requestId, type, metadata = {}) {
    this.traces.set(requestId, {
      requestId,
      type,
      metadata,
      startTime: Date.now(),
      endTime: null,
      status: 'in_progress',
      events: []
    });
  }

  addEvent(requestId, event) {
    const trace = this.traces.get(requestId);
    if (trace) {
      trace.events.push({ ...event, timestamp: Date.now() });
    }
  }

  endTrace(requestId, status = 'success') {
    const trace = this.traces.get(requestId);
    if (trace) {
      trace.endTime = Date.now();
      trace.status = status;
      trace.durationMs = trace.endTime - trace.startTime;
    }
  }

  getFullTrace(requestId) {
    return this.traces.get(requestId) || null;
  }

  getAllTraces(filter = {}) {
    let results = Array.from(this.traces.values());
    if (filter.type) results = results.filter(t => t.type === filter.type);
    if (filter.status) results = results.filter(t => t.status === filter.status);
    if (filter.since) results = results.filter(t => t.startTime >= filter.since);
    return results;
  }

  formatTrace(requestId) {
    const trace = this.traces.get(requestId);
    if (!trace) return null;
    return {
      requestId: trace.requestId,
      type: trace.type,
      status: trace.status,
      durationMs: trace.durationMs || (Date.now() - trace.startTime),
      eventCount: trace.events.length
    };
  }

  getStats() {
    const all = Array.from(this.traces.values());
    return {
      total: all.length,
      inProgress: all.filter(t => t.status === 'in_progress').length,
      success: all.filter(t => t.status === 'success').length,
      error: all.filter(t => t.status === 'error').length
    };
  }

  cleanup(maxAgeMs = 3600000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, trace] of this.traces) {
      if (trace.startTime < cutoff) {
        this.traces.delete(id);
      }
    }
  }
}

module.exports = RequestTracer;
