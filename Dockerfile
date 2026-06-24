FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM golang:1.26-alpine AS backend
WORKDIR /app
COPY go.* ./
RUN go mod download
COPY . .
COPY --from=frontend /app/frontend/dist ./frontend/dist
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o kizuna ./cmd/kizuna/

FROM golang:1.26-alpine AS debug
WORKDIR /app
RUN apk add --no-cache git
RUN go install github.com/go-delve/delve/cmd/dlv@latest
COPY go.* ./
RUN go mod download
COPY . .
COPY --from=frontend /app/frontend/dist ./frontend/dist
RUN CGO_ENABLED=0 go build -gcflags="all=-N -l" -o kizuna ./cmd/kizuna/
EXPOSE 9090 2345
VOLUME /data
ENV CONFIG_PATH=/data/config.json
ENTRYPOINT ["dlv", "--listen=:2345", "--headless=true", "--api-version=2", "--accept-multiclient", "exec", "/app/kizuna"]

FROM alpine:3.19 AS certs
RUN apk add --no-cache ca-certificates

FROM scratch AS final
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=backend /app/kizuna /usr/local/bin/kizuna
EXPOSE 9090
VOLUME /data
ENV CONFIG_PATH=/data/config.json
ENTRYPOINT ["kizuna"]
