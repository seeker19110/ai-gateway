# Multi-stage: cài dependency ở một layer riêng, tách khỏi mã nguồn — sửa code không phải
# cài lại node_modules, và image cuối không mang theo cache của npm.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY lib ./lib
COPY providers ./providers
COPY public ./public
COPY server.js package.json ./

# Chạy bằng user `node` có sẵn trong base image thay vì root — image chạy sai một chỗ thì
# thiệt hại vẫn dừng ở quyền của một user thường.
USER node

EXPOSE 3000

# Dùng `node` sẵn có để gọi /health thay vì cài thêm curl/wget vào image — /health đã tự
# trả 503 khi không còn nhà cung cấp nào sẵn sàng (xem lib/app.js), nên healthcheck này
# phát hiện được cả "container không chạy" lẫn "container chạy nhưng pool đã kiệt".
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
