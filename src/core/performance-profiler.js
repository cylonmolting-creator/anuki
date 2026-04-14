// Performance Profiler - stub implementation (roadmap 10.3)
class PerformanceProfiler {
  constructor() {
    this.metrics = {};
  }

  recordLatency(operation, duration, metadata = {}) {
    if (!this.metrics[operation]) {
      this.metrics[operation] = { count: 0, totalMs: 0, errors: 0 };
    }
    this.metrics[operation].count++;
    this.metrics[operation].totalMs += duration;
  }

  recordError(operation, metadata = {}) {
    if (!this.metrics[operation]) {
      this.metrics[operation] = { count: 0, totalMs: 0, errors: 0 };
    }
    this.metrics[operation].errors++;
  }

  getMetrics() {
    return { ...this.metrics };
  }

  reset() {
    this.metrics = {};
  }

  getSummary() {
    const summary = {};
    for (const [operation, data] of Object.entries(this.metrics)) {
      const avg = data.count > 0 ? data.totalMs / data.count : 0;
      summary[operation] = {
        count: data.count,
        totalMs: Math.round(data.totalMs * 100) / 100,
        avgMs: Math.round(avg * 100) / 100,
        errors: data.errors
      };
    }
    return summary;
  }

  getLayerStats(layer) {
    const data = this.metrics[layer];
    if (!data) return null;
    const avg = data.count > 0 ? data.totalMs / data.count : 0;
    return {
      layer,
      count: data.count,
      totalMs: Math.round(data.totalMs * 100) / 100,
      avgMs: Math.round(avg * 100) / 100,
      errors: data.errors
    };
  }

  getRecentSamples(layer, limit = 50) {
    return [];
  }
}

module.exports = PerformanceProfiler;
