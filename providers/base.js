class BaseProvider {
  constructor(name, displayName, options = {}) {
    this.name = name;
    this.displayName = displayName;
    this.model = options.model || '';
    this.maxRPM = options.maxRPM || 10;
    this.status = 'inactive'; // inactive, active, rate_limited, error
    this.requestCount = 0;
    this.lastError = null;
    this.cooldownUntil = null;
    
    this.startRateLimitReset();
  }

  isAvailable() {
    if (this.status === 'inactive') return false;
    if (this.cooldownUntil && Date.now() < this.cooldownUntil) return false;
    if (this.cooldownUntil && Date.now() >= this.cooldownUntil) {
      this.status = 'active';
      this.cooldownUntil = null;
    }
    if (this.requestCount >= this.maxRPM) return false;
    return true;
  }

  async chat(messages, apiKey) {
    throw new Error('Not implemented');
  }

  async testConnection(apiKey) {
    try {
      await this.chat([{ role: 'user', content: 'Say "hello" only.' }], apiKey);
      this.status = 'active';
      this.lastError = null;
      return true;
    } catch (error) {
      this.status = 'error';
      this.lastError = error.message;
      return false;
    }
  }

  trackRequest() {
    this.requestCount++;
    if (this.requestCount >= this.maxRPM) {
      this.status = 'rate_limited';
    }
  }

  setCooldown(seconds) {
    this.cooldownUntil = Date.now() + (seconds * 1000);
    this.status = 'rate_limited';
  }

  getStatus() {
    return {
      name: this.name,
      displayName: this.displayName,
      status: this.status,
      model: this.model,
      requestCount: this.requestCount,
      maxRPM: this.maxRPM,
      cooldownUntil: this.cooldownUntil,
      lastError: this.lastError
    };
  }

  startRateLimitReset() {
    setInterval(() => {
      this.requestCount = 0;
      if (this.status === 'rate_limited' && (!this.cooldownUntil || Date.now() >= this.cooldownUntil)) {
        this.status = 'active';
      }
    }, 60000); // every minute
  }
}

module.exports = BaseProvider;
