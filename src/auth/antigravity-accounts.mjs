const DEFAULT_CLOCK = Object.freeze({
  nowMs: () => Date.now(),
});

function normalizeAccount(account) {
  if (typeof account === 'string') {
    if (account.length === 0) throw new TypeError('Antigravity account id cannot be empty');
    return { id: account, accountId: account };
  }
  if (!account || typeof account !== 'object') {
    throw new TypeError('Antigravity account must be a string id or object');
  }
  const id = typeof account.id === 'string' && account.id.length > 0
    ? account.id
    : typeof account.accountId === 'string' && account.accountId.length > 0
      ? account.accountId
      : '';
  if (!id) throw new TypeError('Antigravity account object requires id or accountId');
  return Object.freeze({ ...account, id, accountId: id });
}

function normalizeAccounts(accounts) {
  if (!Array.isArray(accounts)) {
    throw new TypeError('Antigravity accounts must be an array');
  }
  const seen = new Set();
  return Object.freeze(accounts.map((account) => {
    const normalized = normalizeAccount(account);
    if (seen.has(normalized.id)) {
      throw new TypeError(`duplicate Antigravity account id: ${normalized.id}`);
    }
    seen.add(normalized.id);
    return normalized;
  }));
}

function normalizeNow(clock) {
  if (typeof clock === 'function') return clock;
  if (clock && typeof clock.nowMs === 'function') return () => clock.nowMs();
  if (clock && typeof clock.now === 'function') return () => clock.now();
  return DEFAULT_CLOCK.nowMs;
}

function parseRetryAfter(retryAfter) {
  if (retryAfter instanceof Date) {
    const retryAfterMs = retryAfter.getTime();
    if (Number.isFinite(retryAfterMs)) return retryAfterMs;
  }
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
    return retryAfter;
  }
  if (typeof retryAfter === 'string' && retryAfter.trim()) {
    const retryAfterMs = Date.parse(retryAfter);
    if (Number.isFinite(retryAfterMs)) return retryAfterMs;
  }
  throw new TypeError(`invalid Antigravity retryAfter: ${retryAfter}`);
}

function retryAfterFromMs(retryAfterMs) {
  return Number.isFinite(retryAfterMs) ? new Date(retryAfterMs).toISOString() : null;
}

class AntigravityAccountRegistry {
  constructor(accounts = [], { clock, nowMs } = {}) {
    this.accounts = normalizeAccounts(accounts);
    this.nowMs = typeof nowMs === 'function' ? nowMs : normalizeNow(clock);
    this.nextIndex = 0;
    this.cooldowns = new Map();
  }

  listAccounts() {
    return this.accounts;
  }

  getCooldown(accountId) {
    const cooldownUntilMs = this.cooldowns.get(accountId) ?? null;
    if (cooldownUntilMs === null || cooldownUntilMs <= this.nowMs()) {
      this.cooldowns.delete(accountId);
      return { accountId, cooledDown: false, retryAfter: null, retryAfterMs: null };
    }
    return {
      accountId,
      cooledDown: true,
      retryAfter: retryAfterFromMs(cooldownUntilMs),
      retryAfterMs: cooldownUntilMs,
    };
  }

  selectAccount() {
    if (this.accounts.length === 0) return null;
    const now = this.nowMs();
    for (let offset = 0; offset < this.accounts.length; offset += 1) {
      const index = (this.nextIndex + offset) % this.accounts.length;
      const account = this.accounts[index];
      const cooldownUntilMs = this.cooldowns.get(account.id);
      if (cooldownUntilMs !== undefined && cooldownUntilMs <= now) {
        this.cooldowns.delete(account.id);
      }
      if (cooldownUntilMs === undefined || cooldownUntilMs <= now) {
        this.nextIndex = (index + 1) % this.accounts.length;
        return account;
      }
    }
    return null;
  }

  markRateLimited(accountId, retryAfter) {
    const account = this.accounts.find((candidate) => candidate.id === accountId);
    if (!account) {
      throw new TypeError(`unknown Antigravity account id: ${accountId}`);
    }
    const retryAfterMs = parseRetryAfter(retryAfter);
    this.cooldowns.set(account.id, retryAfterMs);
    return {
      account,
      retryAfter: retryAfterFromMs(retryAfterMs),
      retryAfterMs,
    };
  }

  allCapped() {
    if (this.accounts.length === 0) {
      return { allCapped: true, retryAfter: null, retryAfterMs: null };
    }
    const now = this.nowMs();
    let earliestRetryAfterMs = null;
    for (const account of this.accounts) {
      const cooldownUntilMs = this.cooldowns.get(account.id);
      if (cooldownUntilMs !== undefined && cooldownUntilMs <= now) {
        this.cooldowns.delete(account.id);
      }
      const activeCooldownMs = this.cooldowns.get(account.id);
      if (activeCooldownMs === undefined) {
        return { allCapped: false, retryAfter: null, retryAfterMs: null };
      }
      earliestRetryAfterMs = earliestRetryAfterMs === null
        ? activeCooldownMs
        : Math.min(earliestRetryAfterMs, activeCooldownMs);
    }
    return {
      allCapped: true,
      retryAfter: retryAfterFromMs(earliestRetryAfterMs),
      retryAfterMs: earliestRetryAfterMs,
    };
  }
}

function createAntigravityAccountRegistry(accounts, options = {}) {
  return new AntigravityAccountRegistry(accounts, options);
}

export {
  AntigravityAccountRegistry,
  createAntigravityAccountRegistry,
  parseRetryAfter,
  retryAfterFromMs,
};
