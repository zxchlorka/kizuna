package api

import (
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/qsnake66/infraview/internal/api/handlers"
	"github.com/qsnake66/infraview/internal/config"
	"github.com/qsnake66/infraview/internal/connector"
)

func NewRouter(cfg *config.AppConfig, manager *connector.ConnectionManager) chi.Router {
	r := chi.NewRouter()

	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.RequestID)

	connHandler := handlers.NewConnectionsHandler(cfg, manager)
	objHandler := handlers.NewObjectsHandler(cfg, manager)
	dataHandler := handlers.NewDataHandler(cfg, manager)

	r.Get("/api/health", handlers.Health)

	r.Route("/api/connections", func(r chi.Router) {
		r.Get("/", connHandler.List)
		r.Post("/", connHandler.Create)

		r.Route("/{id}", func(r chi.Router) {
			r.Put("/", connHandler.Update)
			r.Delete("/", connHandler.Delete)
			r.Post("/test", connHandler.Test)
			r.Get("/info", connHandler.Info)
			r.Get("/objects", objHandler.ListObjects)
			r.Get("/objects/{name}/schema", objHandler.GetSchema)
			r.Get("/objects/{name}/data", dataHandler.GetData)
			r.Post("/mutate", dataHandler.Mutate)
			r.Post("/mutate/bulk", dataHandler.MutateBulk)
		})
	})

	return r
}
