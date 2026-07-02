.PHONY: dev-backend dev-frontend build-frontend build docker docker-run compose-rebuild test clean

dev-backend:
	cd cmd/kizuna && go run .

dev-frontend:
	cd frontend && npm run dev

build-frontend:
	cd frontend && npm ci && npm run build

build: build-frontend
	CGO_ENABLED=0 go build -ldflags="-s -w" -o bin/kizuna ./cmd/kizuna/

docker:
	docker build -t kizuna:latest .

docker-run:
	docker run -p 9090:9090 -v kizuna-data:/data kizuna:latest

compose-rebuild:
	docker compose up --build -d kizuna

test:
	go test ./...

clean:
	rm -rf bin/ frontend/dist/
