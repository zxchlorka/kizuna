.PHONY: dev-backend dev-frontend build-frontend build docker docker-run compose-rebuild test clean

dev-backend:
	cd cmd/infraview && go run .

dev-frontend:
	cd frontend && npm run dev

build-frontend:
	cd frontend && npm ci && npm run build

build: build-frontend
	CGO_ENABLED=0 go build -ldflags="-s -w" -o bin/infraview ./cmd/infraview/

docker:
	docker build -t infraview:latest .

docker-run:
	docker run -p 9090:9090 -v infraview-data:/data infraview:latest

compose-rebuild:
	docker compose up --build -d infraview

test:
	go test ./...

clean:
	rm -rf bin/ frontend/dist/
