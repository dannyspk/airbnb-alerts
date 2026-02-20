import * as dbConfig from './config.js';

/**
 * Database Health Check Utility
 * 
 * Monitors the health of both primary (Supabase) and replica (Railway) databases.
 * Provides detailed connection information, latency measurements, and alerts.
 */

export class DatabaseHealthCheck {
  constructor() {
    this.lastCheck = null;
    this.healthHistory = [];
    this.maxHistorySize = 100;
  }

  /**
   * Perform a health check on both databases
   */
  async check() {
    const timestamp = new Date();
    const status = await dbConfig.getConnectionStatus();

    const healthStatus = {
      timestamp,
      primary: {
        connected: status.primary.connected,
        latency: status.primary.latency,
        error: status.primary.error,
        status: status.primary.connected ? 'healthy' : 'unhealthy'
      },
      replica: {
        connected: status.replica.connected,
        latency: status.replica.latency,
        error: status.replica.error,
        status: status.replica.connected ? 'healthy' : 'unhealthy'
      },
      overall: 'healthy'
    };

    // Determine overall health
    if (!status.primary.connected) {
      healthStatus.overall = 'critical'; // Primary down = critical
    } else if (status.replica && !status.replica.connected) {
      healthStatus.overall = 'degraded'; // Replica down = degraded
    }

    this.lastCheck = healthStatus;
    this.addToHistory(healthStatus);

    return healthStatus;
  }

  /**
   * Add health check to history
   */
  addToHistory(status) {
    this.healthHistory.push(status);
    if (this.healthHistory.length > this.maxHistorySize) {
      this.healthHistory.shift();
    }
  }

  /**
   * Get the latest health check
   */
  getLatestStatus() {
    return this.lastCheck;
  }

  /**
   * Get health check history
   */
  getHistory(limit = null) {
    if (limit) {
      return this.healthHistory.slice(-limit);
    }
    return this.healthHistory;
  }

  /**
   * Format health status for logging
   */
  formatStatus(status = null) {
    const s = status || this.lastCheck;
    if (!s) return 'No health check performed yet';

    const statusEmoji = {
      critical: '🔴',
      degraded: '🟡',
      healthy: '🟢'
    };

    return `
${statusEmoji[s.overall]} Overall: ${s.overall.toUpperCase()}

Primary (Supabase):
  ${s.primary.connected ? '✅' : '❌'} Status: ${s.primary.status}
  ${s.primary.latency !== null ? `⏱️  Latency: ${s.primary.latency}ms` : '⏱️  Latency: N/A'}
  ${s.primary.error ? `Error: ${s.primary.error}` : ''}

Replica (Railway):
  ${s.replica.connected ? '✅' : '❌'} Status: ${s.replica.status}
  ${s.replica.latency !== null ? `⏱️  Latency: ${s.replica.latency}ms` : '⏱️  Latency: N/A'}
  ${s.replica.error ? `Error: ${s.replica.error}` : ''}
    `;
  }

  /**
   * Check specific latency thresholds
   */
  checkLatencyThresholds(warningThreshold = 100, criticalThreshold = 500) {
    if (!this.lastCheck) {
      return { warnings: [], criticals: [] };
    }

    const warnings = [];
    const criticals = [];

    // Check primary
    if (this.lastCheck.primary.latency) {
      if (this.lastCheck.primary.latency > criticalThreshold) {
        criticals.push(`Primary latency ${this.lastCheck.primary.latency}ms exceeds critical threshold`);
      } else if (this.lastCheck.primary.latency > warningThreshold) {
        warnings.push(`Primary latency ${this.lastCheck.primary.latency}ms exceeds warning threshold`);
      }
    }

    // Check replica
    if (this.lastCheck.replica.latency) {
      if (this.lastCheck.replica.latency > criticalThreshold) {
        criticals.push(`Replica latency ${this.lastCheck.replica.latency}ms exceeds critical threshold`);
      } else if (this.lastCheck.replica.latency > warningThreshold) {
        warnings.push(`Replica latency ${this.lastCheck.replica.latency}ms exceeds warning threshold`);
      }
    }

    return { warnings, criticals };
  }

  /**
   * Get uptime statistics from history
   */
  getUptimeStats() {
    if (this.healthHistory.length === 0) {
      return { primaryUptime: 0, replicaUptime: 0, samples: 0 };
    }

    let primaryHealthyCount = 0;
    let replicaHealthyCount = 0;

    for (const status of this.healthHistory) {
      if (status.primary.connected) primaryHealthyCount++;
      if (status.replica.connected) replicaHealthyCount++;
    }

    return {
      primaryUptime: ((primaryHealthyCount / this.healthHistory.length) * 100).toFixed(2),
      replicaUptime: ((replicaHealthyCount / this.healthHistory.length) * 100).toFixed(2),
      samples: this.healthHistory.length
    };
  }

  /**
   * Get average latencies from history
   */
  getAverageLatencies() {
    if (this.healthHistory.length === 0) {
      return { primary: null, replica: null };
    }

    let primaryLatencySum = 0;
    let primaryCount = 0;
    let replicaLatencySum = 0;
    let replicaCount = 0;

    for (const status of this.healthHistory) {
      if (status.primary.latency !== null) {
        primaryLatencySum += status.primary.latency;
        primaryCount++;
      }
      if (status.replica.latency !== null) {
        replicaLatencySum += status.replica.latency;
        replicaCount++;
      }
    }

    return {
      primary: primaryCount > 0 ? (primaryLatencySum / primaryCount).toFixed(2) : null,
      replica: replicaCount > 0 ? (replicaLatencySum / replicaCount).toFixed(2) : null
    };
  }

  /**
   * Generate a comprehensive health report
   */
  generateReport() {
    const uptime = this.getUptimeStats();
    const latencies = this.getAverageLatencies();
    const thresholds = this.checkLatencyThresholds();

    return {
      timestamp: new Date(),
      currentStatus: this.lastCheck,
      uptime,
      averageLatencies: latencies,
      alerts: {
        warnings: thresholds.warnings,
        criticals: thresholds.criticals
      },
      historySize: this.healthHistory.length
    };
  }
}

/**
 * Create and export a singleton instance
 */
export const healthCheck = new DatabaseHealthCheck();

/**
 * Express middleware for health check endpoint
 */
export function healthCheckMiddleware(req, res, next) {
  const status = healthCheck.getLatestStatus();

  if (!status) {
    return res.status(503).json({
      status: 'unknown',
      message: 'No health check performed yet'
    });
  }

  const statusCode = status.overall === 'critical' ? 503 : 200;

  res.status(statusCode).json({
    status: status.overall,
    timestamp: status.timestamp,
    primary: {
      connected: status.primary.connected,
      latency: status.primary.latency
    },
    replica: {
      connected: status.replica.connected,
      latency: status.replica.latency
    }
  });
}

/**
 * Run continuous health checks
 */
export async function startHealthCheckMonitor(intervalMs = 30000) {
  await healthCheck.check(); // Initial check
  console.log('✅ Health check monitor started');

  const intervalId = setInterval(async () => {
    try {
      const status = await healthCheck.check();
      if (status.overall !== 'healthy') {
        console.warn('⚠️  Database health check alert:', healthCheck.formatStatus(status));
      }
    } catch (err) {
      console.error('❌ Health check error:', err);
    }
  }, intervalMs);

  return intervalId;
}

/**
 * Stop health check monitor
 */
export function stopHealthCheckMonitor(intervalId) {
  if (intervalId) {
    clearInterval(intervalId);
    console.log('✅ Health check monitor stopped');
  }
}

export default {
  DatabaseHealthCheck,
  healthCheck,
  healthCheckMiddleware,
  startHealthCheckMonitor,
  stopHealthCheckMonitor
};
