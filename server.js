require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const GeminiProvider = require('./providers/gemini');
const GroqProvider = require('./providers/groq');
const OpenAIProvider = require('./providers/openai');
const ClaudeProvider = require('./providers/claude');

class SmartRouter {
  constructor() {
    this.providers = {
      gemini: new GeminiProvider(),
      groq: new GroqProvider(),
      openai: new OpenAIProvider(),
      claude: new ClaudeProvider()
    };
    this.providerKeys = Object.keys(this.providers);
    this.roundRobinIndex = 0;
  }

  configureProviders(apiKeys) {
    for (const [key, provider] of Object.entries(this.providers)) {
      const apiKey = apiKeys[key] || process.env[`${key.toUpperCase()}_API_KEY`];
      if (apiKey) {
        if (provider.status === 'inactive') {
          provider.status = 'active';
        }
      } else {
        provider.status = 'inactive';
      }
    }
  }

  getNextProvider(preferred) {
    if (preferred && this.providers[preferred] && this.providers[preferred].isAvailable()) {
      return this.providers[preferred];
    }

    let attempts = 0;
    while (attempts < this.providerKeys.length) {
      const providerName = this.providerKeys[this.roundRobinIndex];
      this.roundRobinIndex = (this.roundRobinIndex + 1) % this.providerKeys.length;
      
      const provider = this.providers[providerName];
      if (provider.isAvailable()) {
        return provider;
      }
      attempts++;
    }
    
    return null;
  }

  handleError(providerName, error) {
    const provider = this.providers[providerName];
    if (provider) {
      provider.lastError = error.message;
      if (error.message.includes('Rate limited') || error.message.includes('429')) {
        provider.setCooldown(60);
      } else {
        provider.status = 'error';
      }
    }
  }

  getAllStatuses() {
    const statuses = {};
    for (const [key, provider] of Object.entries(this.providers)) {
      statuses[key] = provider.getStatus();
    }
    return statuses;
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const router = new SmartRouter();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [], providers = {}, preferredProvider } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Nội dung tin nhắn không được trống' });
    }

    router.configureProviders(providers);
    
    const messages = [...history, { role: 'user', content: message }];
    
    const attemptedProviders = [];
    let currentProvider = router.getNextProvider(preferredProvider);
    let success = false;
    let responseText = '';
    let finalProviderName = '';

    while (currentProvider && !success) {
      attemptedProviders.push(currentProvider.name);
      const apiKey = providers[currentProvider.name] || process.env[`${currentProvider.name.toUpperCase()}_API_KEY`];
      
      console.log(`[${new Date().toISOString()}] Routing request to ${currentProvider.name}`);
      
      try {
        responseText = await currentProvider.chat(messages, apiKey);
        success = true;
        finalProviderName = currentProvider.name;
        console.log(`[${new Date().toISOString()}] Request successful with ${currentProvider.name}`);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Provider ${currentProvider.name} failed: ${error.message}`);
        router.handleError(currentProvider.name, error);
        currentProvider = router.getNextProvider();
        
        // Prevent infinite loop if we've tried all available providers
        if (currentProvider && attemptedProviders.includes(currentProvider.name)) {
            break;
        }
      }
    }

    if (!success) {
      return res.status(503).json({ 
        error: 'Tất cả các API provider đều không khả dụng hoặc bị lỗi. Vui lòng thử lại sau.',
        statuses: router.getAllStatuses()
      });
    }

    res.json({
      provider: finalProviderName,
      response: responseText,
      status: router.getAllStatuses()
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Internal server error:`, error);
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ' });
  }
});

app.get('/api/providers/status', (req, res) => {
  try {
    const providersParam = req.query.providers;
    let providerKeys = {};
    
    if (providersParam) {
      try {
        providerKeys = JSON.parse(providersParam);
      } catch (e) {
        console.warn('Could not parse providers query param');
      }
    }
    
    router.configureProviders(providerKeys);
    res.json(router.getAllStatuses());
  } catch (error) {
    res.status(500).json({ error: 'Lỗi máy chủ' });
  }
});

app.post('/api/providers/test', async (req, res) => {
  try {
    const { provider, apiKey } = req.body;
    
    if (!provider || !apiKey) {
      return res.status(400).json({ success: false, message: 'Thiếu tên provider hoặc API key' });
    }
    
    const p = router.providers[provider];
    if (!p) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy provider' });
    }
    
    const isSuccess = await p.testConnection(apiKey);
    
    if (isSuccess) {
      res.json({ success: true, message: 'Kết nối thành công!' });
    } else {
      res.json({ success: false, message: p.lastError || 'Kết nối thất bại' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`AI Gateway Server running on port ${PORT}`);
});
