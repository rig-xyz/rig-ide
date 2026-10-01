'use strict';

/**
 * This app's macOS notification permission. `getStatus()` answers
 * 'authorized' | 'denied' | 'notDetermined' | 'provisional' | 'unknown',
 * or 'unsupported' off macOS or when the addon isn't built. Never throws.
 */
let binding = null;
try {
  binding = require('./build/Release/mac_notifications.node');
} catch {
  binding = null;
}

function getStatus() {
  if (!binding) return 'unsupported';
  try {
    return binding.getStatus();
  } catch {
    return 'unknown';
  }
}

function request() {
  if (!binding) return;
  try {
    binding.request();
  } catch {
    // nothing to do: the status read afterwards says what happened
  }
}

function bundleId() {
  if (!binding) return null;
  try {
    return binding.bundleId();
  } catch {
    return null;
  }
}

module.exports = { bundleId, getStatus, request };
