/**
 * RPC URL & Helius API Key auto-rotation.
 *
 * Manages multiple RPC endpoints and Helius API keys. When a rate-limit
 * (HTTP 429) or connection error is detected, automatically rotates to
 * the next available key without stopping the application.
 *
 * Keys are read from user-config.json arrays:
 *   "rpcUrls":       ["url1", "url2", ...]
 *   "heliusApiKeys": ["key1", "key2", ...]
 *
 * Falls back to single process.env.RPC_URL / HELIUS_API_KEY if arrays
 * are not configured.
 */

import { Connection } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const COOLDOWN_MS = 60_000; // 60s cooldown per key after a 429

// ─── State ──────────────────────────────────────────────────────

let _rpcUrls = [];
let _heliusKeys = [];
let _rpcIndex = 0;
let _heliusIndex = 0;
let _rpcCooldowns = new Map();     // url → timestamp when cooldown expires
let _heliusCooldowns = new Map();  // key → timestamp when cooldown expires
let _connection = null;
let _currentRpcUrl = null;

// ─── Load keys from user-config.json ────────────────────────────

function loadKeys() {
  let u = {};
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      u = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    }
  } catch { /* ignore */ }

  // RPC URLs: array from config, or single from env
  if (Array.isArray(u.rpcUrls) && u.rpcUrls.length > 0) {
    _rpcUrls = u.rpcUrls.filter(Boolean);
  } else if (process.env.RPC_URL) {
    _rpcUrls = [process.env.RPC_URL];
  }

  // Helius keys: array from config, or single from env
  if (Array.isArray(u.heliusApiKeys) && u.heliusApiKeys.length > 0) {
    _heliusKeys = u.heliusApiKeys.filter(Boolean);
  } else if (process.env.HELIUS_API_KEY) {
    _heliusKeys = [process.env.HELIUS_API_KEY];
  }

  if (_rpcUrls.length > 1) {
    log("rpc_rotator", `Loaded ${_rpcUrls.length} RPC URLs for rotation`);
  }
  if (_heliusKeys.length > 1) {
    log("rpc_rotator", `Loaded ${_heliusKeys.length} Helius API keys for rotation`);
  }
}

// Load on import
loadKeys();

// ─── RPC URL Rotation ───────────────────────────────────────────

/**
 * Get the current best RPC URL (skips cooled-down URLs).
 */
export function getRpcUrl() {
  if (_rpcUrls.length === 0) return process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  if (_rpcUrls.length === 1) return _rpcUrls[0];

  const now = Date.now();
  // Try from current index, wrapping around
  for (let i = 0; i < _rpcUrls.length; i++) {
    const idx = (_rpcIndex + i) % _rpcUrls.length;
    const url = _rpcUrls[idx];
    const cooldownUntil = _rpcCooldowns.get(url) || 0;
    if (now >= cooldownUntil) {
      _rpcIndex = idx;
      return url;
    }
  }

  // All on cooldown — use the one with earliest expiry
  let bestIdx = 0;
  let bestExpiry = Infinity;
  for (let i = 0; i < _rpcUrls.length; i++) {
    const expiry = _rpcCooldowns.get(_rpcUrls[i]) || 0;
    if (expiry < bestExpiry) {
      bestExpiry = expiry;
      bestIdx = i;
    }
  }
  _rpcIndex = bestIdx;
  return _rpcUrls[bestIdx];
}

/**
 * Report an RPC error. If it's a rate limit, rotate to next URL.
 * @param {Error|Object} error - The error object
 * @returns {boolean} true if rotation happened
 */
export function reportRpcError(error) {
  if (!isRateLimitError(error) || _rpcUrls.length <= 1) return false;

  const currentUrl = _rpcUrls[_rpcIndex];
  _rpcCooldowns.set(currentUrl, Date.now() + COOLDOWN_MS);

  const oldIndex = _rpcIndex;
  _rpcIndex = (_rpcIndex + 1) % _rpcUrls.length;

  // Invalidate the current connection so a fresh one is created
  _connection = null;
  _currentRpcUrl = null;

  const maskedOld = maskUrl(currentUrl);
  const maskedNew = maskUrl(_rpcUrls[_rpcIndex]);
  log("rpc_rotator", `🔄 RPC rate limited! Rotated: ${maskedOld} → ${maskedNew} (cooldown ${COOLDOWN_MS / 1000}s)`);

  return true;
}

// ─── Helius Key Rotation ────────────────────────────────────────

/**
 * Get the current best Helius API key (skips cooled-down keys).
 */
export function getHeliusKey() {
  if (_heliusKeys.length === 0) return process.env.HELIUS_API_KEY || "";
  if (_heliusKeys.length === 1) return _heliusKeys[0];

  const now = Date.now();
  for (let i = 0; i < _heliusKeys.length; i++) {
    const idx = (_heliusIndex + i) % _heliusKeys.length;
    const key = _heliusKeys[idx];
    const cooldownUntil = _heliusCooldowns.get(key) || 0;
    if (now >= cooldownUntil) {
      _heliusIndex = idx;
      return key;
    }
  }

  // All on cooldown — use earliest expiry
  let bestIdx = 0;
  let bestExpiry = Infinity;
  for (let i = 0; i < _heliusKeys.length; i++) {
    const expiry = _heliusCooldowns.get(_heliusKeys[i]) || 0;
    if (expiry < bestExpiry) {
      bestExpiry = expiry;
      bestIdx = i;
    }
  }
  _heliusIndex = bestIdx;
  return _heliusKeys[bestIdx];
}

/**
 * Report a Helius API error. If it's a rate limit, rotate to next key.
 * @param {Error|Object} error - The error object
 * @returns {boolean} true if rotation happened
 */
export function reportHeliusError(error) {
  if (!isRateLimitError(error) || _heliusKeys.length <= 1) return false;

  const currentKey = _heliusKeys[_heliusIndex];
  _heliusCooldowns.set(currentKey, Date.now() + COOLDOWN_MS);

  _heliusIndex = (_heliusIndex + 1) % _heliusKeys.length;

  const maskedOld = maskKey(currentKey);
  const maskedNew = maskKey(_heliusKeys[_heliusIndex]);
  log("rpc_rotator", `🔄 Helius rate limited! Rotated: ${maskedOld} → ${maskedNew} (cooldown ${COOLDOWN_MS / 1000}s)`);

  return true;
}

// ─── Shared Connection (replaces singletons in dlmm.js/wallet.js) ──

/**
 * Get a Connection instance. Automatically re-creates if the RPC URL
 * changed due to rotation.
 */
export function getConnection() {
  const url = getRpcUrl();
  if (!_connection || _currentRpcUrl !== url) {
    _connection = new Connection(url, "confirmed");
    _currentRpcUrl = url;
  }
  return _connection;
}

/**
 * Force invalidate the connection (e.g. after detecting a stale connection).
 */
export function invalidateConnection() {
  _connection = null;
  _currentRpcUrl = null;
}

// ─── Reload keys at runtime (called by config system) ───────────

export function reloadRotatorKeys() {
  loadKeys();
}

// ─── Status (for debugging / Telegram) ──────────────────────────

export function getRotatorStatus() {
  const now = Date.now();
  return {
    rpc: {
      total: _rpcUrls.length,
      current_index: _rpcIndex,
      current_url: maskUrl(_rpcUrls[_rpcIndex] || "none"),
      cooldowns: _rpcUrls.map((url, i) => ({
        index: i,
        url: maskUrl(url),
        on_cooldown: (_rpcCooldowns.get(url) || 0) > now,
        cooldown_remaining_s: Math.max(0, Math.round(((_rpcCooldowns.get(url) || 0) - now) / 1000)),
      })),
    },
    helius: {
      total: _heliusKeys.length,
      current_index: _heliusIndex,
      current_key: maskKey(_heliusKeys[_heliusIndex] || "none"),
      cooldowns: _heliusKeys.map((key, i) => ({
        index: i,
        key: maskKey(key),
        on_cooldown: (_heliusCooldowns.get(key) || 0) > now,
        cooldown_remaining_s: Math.max(0, Math.round(((_heliusCooldowns.get(key) || 0) - now) / 1000)),
      })),
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function isRateLimitError(error) {
  if (!error) return false;
  // HTTP 429
  if (error.status === 429 || error.statusCode === 429) return true;
  const msg = (error.message || error.toString() || "").toLowerCase();
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many request") || msg.includes("throttl")) return true;
  // Solana RPC specific
  if (msg.includes("server responded with 429")) return true;
  return false;
}

function maskUrl(url) {
  if (!url) return "none";
  try {
    const u = new URL(url);
    // Mask API key in query params
    const params = new URLSearchParams(u.search);
    for (const [key] of params) {
      if (key.toLowerCase().includes("key") || key.toLowerCase().includes("api")) {
        const val = params.get(key);
        params.set(key, val.slice(0, 4) + "..." + val.slice(-4));
      }
    }
    u.search = params.toString();
    return u.toString();
  } catch {
    return url.slice(0, 20) + "...";
  }
}

function maskKey(key) {
  if (!key || key.length < 8) return key || "none";
  return key.slice(0, 4) + "..." + key.slice(-4);
}
