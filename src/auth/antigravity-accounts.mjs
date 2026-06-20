import { listCredentialAccounts } from './antigravity-bridge.mjs';

class AntigravityAccountRegistryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AntigravityAccountRegistryError';
    this.code = code;
    Object.assign(this, details);
  }
}

function defaultClock() {
  return Date.now();
}

function normalizeAccountIds(accountIds) {
  if (!Array.isArray(accountIds)) {
    throw new AntigravityAccountRegistryError('ACCOUNTS_INVALID', 'Antigravity account list must be an array');
  }

  const seen = new Set();
  const normalized = [];
  for (const accountId of accountIds) {
    if (typeof accountId !== 'string' || accountId.length === 0) {
      throw new AntigravityAccountRegistryError('ACCOUNT_ID_INVALID', `invalid Antigravity account id: ${accountId}`);
    }
    if (seen.has(accountId)) continue;
    seen.add(accountId);
    normalized.push(accountId);
  }
  return normalized;
}

function normalizeRetryAfter(retryAfter) {
  const retryAfterMs = retryAfter instanceof Date
    ? retryAfter.getTime()
    : typeof retryAfter === 'number'
      ? retryAfter
      : Date.parse(String(retryAfter || ''));
  if (!Number.isFinite(retryAfterMs)) {
    throw new AntigravityAccountRegistryError('RETRY_AFTER_INVALID', `invalid retryAfter: ${retryAfter}`);
  }
  return {
    retryAfter: new Date(retryAfterMs).toISOString(),
    retryAfterMs,
  };
}

class AntigravityAccountRegistry {
  constructor({
    accountIds = null,
    listAccounts = listCredentialAccounts,
    clock = defaultClock,
  } = {}) {
    this.accountIds = accountIds ? normalizeAccountIds(accountIds) : null;
    this.listAccounts = listAccounts;
    this.clock = clock;
    this.nextIndex = 0;
    this.cooldowns = new Map();
  }

  accounts() {
    const accountIds = this.accountIds || this.listAccounts();
    return normalizeAccountIds(accountIds);
  }

  nowMs() {
    const now = this.clock();
    if (!Number.isFinite(now)) {
      throw new AntigravityAccountRegistryError('CLOCK_INVALID', `invalid Antigravity account clock value: ${now}`);
    }
    return now;
  }

  cooldownFor(accountId, nowMs = this.nowMs()) {
    const cooldown = this.cooldowns.get(accountId);
    if (!cooldown) return null;
    if (cooldown.retryAfterMs <= nowMs) {
      this.cooldowns.delete(accountId);
      return null;
    }
    return cooldown;
  }

  selectAccount() {
    const accounts = this.accounts();
    if (accounts.length === 0) return null;

    const nowMs = this.nowMs();
    const startIndex = this.nextIndex % accounts.length;
    for (let offset = 0; offset < accounts.length; offset += 1) {
      const index = (startIndex + offset) % accounts.length;
      const accountId = accounts[index];
      if (this.cooldownFor(accountId, nowMs)) continue;
      this.nextIndex = (index + 1) % accounts.length;
      return accountId;
    }

    return null;
  }

  markRateLimited(accountId, retryAfter) {
    const accounts = this.accounts();
    if (!accounts.includes(accountId)) {
      throw new AntigravityAccountRegistryError('ACCOUNT_UNKNOWN', `unknown Antigravity account id: ${accountId}`, {
        accountId,
      });
    }
    const cooldown = normalizeRetryAfter(retryAfter);
    this.cooldowns.set(accountId, cooldown);
    return {
      accountId,
      retryAfter: cooldown.retryAfter,
    };
  }

  allCapped() {
    const accounts = this.accounts();
    if (accounts.length === 0) {
      return { allCapped: false, retryAfter: null };
    }

    const nowMs = this.nowMs();
    let earliest = null;
    for (const accountId of accounts) {
      const cooldown = this.cooldownFor(accountId, nowMs);
      if (!cooldown) {
        return { allCapped: false, retryAfter: null };
      }
      if (!earliest || cooldown.retryAfterMs < earliest.retryAfterMs) {
        earliest = cooldown;
      }
    }

    return {
      allCapped: true,
      retryAfter: earliest.retryAfter,
    };
  }

  status() {
    const nowMs = this.nowMs();
    return this.accounts().map((accountId) => {
      const cooldown = this.cooldownFor(accountId, nowMs);
      return {
        accountId,
        eligible: !cooldown,
        retryAfter: cooldown?.retryAfter || null,
      };
    });
  }

  clearCooldowns() {
    this.cooldowns.clear();
  }
}

const defaultRegistry = new AntigravityAccountRegistry();

function createAntigravityAccountRegistry(options = {}) {
  return new AntigravityAccountRegistry(options);
}

function selectAccount() {
  return defaultRegistry.selectAccount();
}

function markRateLimited(accountId, retryAfter) {
  return defaultRegistry.markRateLimited(accountId, retryAfter);
}

function allCapped() {
  return defaultRegistry.allCapped();
}

function accountStatus() {
  return defaultRegistry.status();
}

function clearAccountCooldowns() {
  defaultRegistry.clearCooldowns();
}

export {
  AntigravityAccountRegistry,
  AntigravityAccountRegistryError,
  accountStatus,
  allCapped,
  clearAccountCooldowns,
  createAntigravityAccountRegistry,
  markRateLimited,
  selectAccount,
};
