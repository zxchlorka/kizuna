package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	kizuna "github.com/zxchlorka/kizuna"
	"github.com/zxchlorka/kizuna/internal/api"
	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
	"github.com/zxchlorka/kizuna/internal/connector/kafka"
	"github.com/zxchlorka/kizuna/internal/connector/postgres"
	redisconnector "github.com/zxchlorka/kizuna/internal/connector/redis"
	"github.com/zxchlorka/kizuna/internal/server"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	configPath := "./config.json"
	if v := os.Getenv("CONFIG_PATH"); v != "" {
		configPath = v
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		slog.Error("failed to load config", "error", err)
		os.Exit(1)
	}

	// Generate encryption key if not set
	if cfg.EncryptionKey == "" {
		key := make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			slog.Error("failed to generate encryption key", "error", err)
			os.Exit(1)
		}
		cfg.EncryptionKey = hex.EncodeToString(key)
		if err := cfg.Save(configPath); err != nil {
			slog.Error("failed to save config with encryption key", "error", err)
			os.Exit(1)
		}
	}

	// Set up ConnectionManager with factories
	manager := connector.NewConnectionManager(cfg)
	manager.RegisterFactory("postgres", postgres.NewFactory())
	manager.RegisterFactory("redis", redisconnector.NewFactory())
	manager.RegisterFactory("kafka", kafka.NewFactory())
	defer manager.CloseAll()

	router := api.NewRouter(cfg, manager)

	// Create sub-filesystem rooted at frontend/dist
	frontendRoot, err := fs.Sub(kizuna.FrontendFS, "frontend/dist")
	if err != nil {
		slog.Error("failed to create frontend sub-fs", "error", err)
		os.Exit(1)
	}

	srv := server.New(router, frontendRoot, ":9090")

	go func() {
		slog.Info("starting server", "addr", ":9090")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	slog.Info("shutting down server")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("server shutdown error", "error", err)
	}
}
