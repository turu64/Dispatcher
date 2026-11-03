# 画面(React + Vite)をビルドして、nginx で配る。
# ビルドの文脈はリポジトリの最上位:docker build -f web/Dockerfile .
# /api は FastAPI(server)に中継する(deploy/nginx.conf)。API キーなどの秘密はイメージに入れない。

FROM node:22-alpine AS build
WORKDIR /app/web
# pnpm は package.json の packageManager(10 系)に従って corepack が用意する
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM nginx:1.29-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
