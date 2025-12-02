#!/usr/bin/env node
/**
 * VPS Monitor Pro+ v1.0 - Official Node Agent (Daemon)
 * Fully compatible with app.js v6.0+ Ultimate Edition
 * Made with ❤️ by Hopingboyz
 */

require('dotenv').config();
const os = require('os');
const fs = require('fs');
const path = require('path');
const si = require('systeminformation');
const axios = require('axios');
const { execSync } = require('child_process');

// ======================
// LOAD & VALIDATE .ENV
// ======================
const requiredEnv = ['SERVER_URL', 'API_KEY', 'NODE_NAME'];

requiredEnv.forEach(key => {
    if (!process.env[key] || process.env[key].trim() === '') {
        console.error(`\x1b[31mERROR: Missing required environment variable: ${key}\x1b[0m`);
        console.error(`Please set it in your .env file or environment.`);
        process.exit(1);
    }
});

if (process.env.API_KEY.length !== 64 || !/^[a-f0-9]{64}$/i.test(process.env.API_KEY)) {
    console.error('\x1b[31mERROR: API_KEY must be exactly 64 hexadecimal characters!\x1b[0m');
    process.exit(1);
}

if (!process.env.SERVER_URL.startsWith('http://') && !process.env.SERVER_URL.startsWith('https://')) {
    console.error('\x1b[31mERROR: SERVER_URL must start with http:// or https://\x1b[0m');
    process.exit(1);
}

// ======================
// CONFIGURATION
// ======================
const CONFIG = {
    SERVER_URL: process.env.SERVER_URL.replace(/\/+$/, ''), // Remove trailing slashes
    API_KEY: process.env.API_KEY.trim(),
    NODE_NAME: (process.env.NODE_NAME || os.hostname()).trim(),
    REPORT_INTERVAL: Math.max(500, parseInt(process.env.REPORT_INTERVAL || '1000')), // min 5s
    LATENCY_TEST: process.env.LATENCY_TEST !== 'false',
    DEBUG: process.env.DEBUG === 'true',
    MAX_RECONNECT_ATTEMPTS: 20,
    RECONNECT_BASE_DELAY: 3000
};

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const debug = (msg) => CONFIG.DEBUG && log(`[DEBUG] ${msg}`);

// Prevent multiple instances
const LOCK_FILE = '/tmp/vps-monitor-agent.lock';
if (fs.existsSync(LOCK_FILE)) {
    try {
        const pid = fs.readFileSync(LOCK_FILE, 'utf8');
        process.kill(pid, 0);
        log('Another instance is already running. Exiting.');
        process.exit(1);
    } catch (e) {
        // Stale lock, override
    }
}
fs.writeFileSync(LOCK_FILE, process.pid.toString());
process.on('exit', () => fs.unlinkSync(LOCK_FILE, () => {}));

// ======================
// STATE
// ======================
let isRegistered = false;
let reconnectAttempts = 0;

// ======================
// LATENCY TEST
// ======================
async function measureLatency() {
    if (!CONFIG.LATENCY_TEST) return 0;
    const start = Date.now();
    try {
        const res = await axios.get(CONFIG.SERVER_URL, { timeout: 5000 });
        return Date.now() - start;
    } catch {
        return 9999;
    }
}

// ======================
// REGISTRATION
// ======================
async function registerNode() {
    try {
        const response = await axios.post(
            `${CONFIG.SERVER_URL}/api/node/register`,
            {
                api_key: CONFIG.API_KEY,
                name: CONFIG.NODE_NAME,
                hostname: os.hostname(),
                agent_version: '6.1'
            },
            { timeout: 10000 }
        );

        if (response.data.success) {
            log(`Node registered successfully (ID: ${response.data.node_id || 'unknown'})`);
            isRegistered = true;
            reconnectAttempts = 0;
            return true;
        } else {
            log(`Registration failed: ${response.data.error || 'Unknown error'}`);
        }
    } catch (err) {
        log(`Registration attempt failed: ${err.response?.data?.error || err.message}`);
    }
    return false;
}

// ======================
// SYSTEM STATS COLLECTION
// ======================
async function getSystemStats() {
    try {
        const [
            currentLoad,
            cpu,
            mem,
            diskLayout,
            fsSize,
            netStats,
            netInterfaces,
            osInfo,
            processes,
            temp
        ] = await Promise.all([
            si.currentLoad(),
            si.cpu(),
            si.mem(),
            si.diskLayout(),
            si.fsSize(),
            si.networkStats(),
            si.networkInterfaces(),
            si.osInfo(),
            si.processes(),
            si.cpuTemperature().catch(() => ({ main: null, cores: [] }))
        ]);

        // Network speed
        const defaultIface = netInterfaces.find(i => i.default) || netInterfaces[0] || {};
        const ifaceStats = netStats.find(s => s.iface === defaultIface.iface) || netStats[0] || {};
        const rx_sec = ifaceStats.rx_sec || 0;
        const tx_sec = ifaceStats.tx_sec || 0;

        // Root disk usage
        const rootDisk = fsSize.find(d => d.mount === '/' || d.mount === 'C:\\' || d.mount.includes('/home')) || fsSize[0] || {};

        // CPU Temp
        const cpuTemp = temp.main !== null && temp.main > 0 ? temp.main : (temp.cores[0] || 0);

        return {
            cpu: Math.round(currentLoad.currentLoad || 0),
            cpu_cores: cpu.cores || os.cpus().length,
            memory: {
                total: mem.total,
                used: mem.used,
                free: mem.free,
                usedPercent: Number(((mem.used / mem.total) * 100).toFixed(2))
            },
            disk: {
                total: rootDisk.size || 0,
                used: rootDisk.used || 0,
                free: rootDisk.available || 0,
                usedPercent: rootDisk.size ? Number(((rootDisk.used / rootDisk.size) * 100).toFixed(2)) : 0
            },
            network: {
                interface: defaultIface.iface || 'unknown',
                rx_sec: Math.round(rx_sec),
                tx_sec: Math.round(tx_sec),
                rx_mb: Number((rx_sec / 1024 / 1024).toFixed(2)),
                tx_mb: Number((tx_sec / 1024 / 1024).toFixed(2))
            },
            uptime: Math.round(os.uptime()),
            loadavg: os.loadavg(),
            cpu_temp: cpuTemp,
            processes: processes.all || 0,
            os_version: `${osInfo.distro || 'Unknown'} ${osInfo.release || ''} (${osInfo.arch || ''})`.trim()
        };
    } catch (err) {
        log(`Failed to collect system stats: ${err.message}`);
        return null;
    }
}

// ======================
// SEND REPORT
// ======================
async function sendReport() {
    if (!isRegistered) {
        const success = await registerNode();
        if (!success) {
            scheduleReconnect();
            return;
        }
    }

    const stats = await getSystemStats();
    if (!stats) return;

    const latency = await measureLatency();

    try {
        await axios.post(
            `${CONFIG.SERVER_URL}/api/node/report`,
            {
                api_key: CONFIG.API_KEY,
                latency,
                stats
            },
            { timeout: 15000 }
        );

        debug(`Report OK | CPU ${stats.cpu}% | RAM ${stats.memory.usedPercent}% | Net ↓${stats.network.rx_mb}MB/s ↑${stats.network.tx_mb}MB/s | Temp ${stats.cpu_temp}°C`);
        reconnectAttempts = 0; // Reset on success
    } catch (err) {
        log(`Report failed: ${err.response?.data?.error || err.message}`);
        isRegistered = false;
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
        log('Max reconnection attempts reached. Stopping agent.');
        process.exit(1);
    }
    const delay = CONFIG.RECONNECT_BASE_DELAY * Math.pow(1.5, reconnectAttempts);
    reconnectAttempts++;
    log(`Reconnecting in ${Math.round(delay/1000)}s... (attempt ${reconnectAttempts})`);
    setTimeout(sendReport, delay);
}

// ======================
// GRACEFUL SHUTDOWN
// ======================
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
    log('Shutting down agent gracefully...');
    if (fs.existsSync(LOCK_FILE)) {
        fs.unlinkSync(LOCK_FILE);
    }
    process.exit(0);
}

// ======================
// START AGENT
// ======================
log('==============================================================');
log('  VPS Monitor Pro+ v1.0 - Node Agent (Ultimate Edition)');
log('  Secure • Real-time • Zero-downtime • Full Metrics');
log(`  Server: ${CONFIG.SERVER_URL}`);
log(`  Node: ${CONFIG.NODE_NAME}`);
log(`  Interval: ${CONFIG.REPORT_INTERVAL / 1000}s`);
log('==============================================================');

(async () => {
    log('Starting agent...');
    await sendReport(); // First attempt immediately
    setInterval(sendReport, CONFIG.REPORT_INTERVAL);
})();