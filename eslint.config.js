'use strict';

/**
 * Cấu hình tối giản: bắt lỗi thật (biến chưa dùng, biến chưa khai báo) chứ không áp đặt
 * phong cách viết code — dự án đã có phong cách nhất quán riêng (comment giải thích "vì
 * sao" bằng tiếng Việt, không dùng semicolon-free...), một bộ rule style đầy đủ sẽ đánh
 * nhau với phong cách đó nhiều hơn là giúp ích.
 */
module.exports = [
  {
    ignores: ['node_modules/**']
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortSignal: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error'
    }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        global: 'writable'
      }
    }
  },
  {
    // Chạy thẳng trong trình duyệt bằng thẻ <script> (không qua bundler, không module) —
    // mọi `class`/`const` khai báo ở top-level của một file là global cho MỌI file khác
    // nạp sau nó (đúng thứ tự nạp trong index.html). ESLint lint từng file riêng lẻ nên
    // không tự thấy được điều đó — khai các global "được định nghĩa ở file khác" ở đây,
    // và tắt `no-unused-vars` cho khai báo top-level (một class không được import ở đâu
    // trong CÙNG file vẫn hoàn toàn có thể đang được dùng bởi file nạp sau nó).
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        alert: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        marked: 'readonly',
        DOMPurify: 'readonly',
        hljs: 'readonly',
        ChatManager: 'readonly',
        SettingsManager: 'readonly',
        ProviderRouter: 'readonly',
        adminFetch: 'readonly',
        clientFetch: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': 'off'
    }
  }
];
