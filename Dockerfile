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
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o infraview ./cmd/infraview/

FROM golang:1.26-alpine AS debug
WORKDIR /app
RUN apk add --no-cache git
RUN go install github.com/go-delve/delve/cmd/dlv@latest
COPY go.* ./
RUN go mod download
COPY . .
COPY --from=frontend /app/frontend/dist ./frontend/dist
RUN CGO_ENABLED=0 go build -gcflags="all=-N -l" -o infraview ./cmd/infraview/
EXPOSE 9090 2345
VOLUME /data
ENV CONFIG_PATH=/data/config.json
ENTRYPOINT ["dlv", "--listen=:2345", "--headless=true", "--api-version=2", "--accept-multiclient", "exec", "/usr/local/bin/infraview"]

FROM alpine:3.19 AS final
RUN apk add --no-cache ca-certificates
COPY --from=backend /app/infraview /usr/local/bin/infraview
EXPOSE 9090
VOLUME /data
ENV CONFIG_PATH=/data/config.json
ENTRYPOINT ["infraview"]
