package api

import (
	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/zxchlorka/kizuna/internal/api/handlers"
	apimiddleware "github.com/zxchlorka/kizuna/internal/api/middleware"
	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
)

func NewRouter(cfg *config.AppConfig, manager *connector.ConnectionManager) chi.Router {
	r := chi.NewRouter()

	r.Use(chimiddleware.RequestID)
	r.Use(apimiddleware.Recovery)
	r.Use(apimiddleware.Logging)
	r.Use(apimiddleware.Audit)

	connHandler := handlers.NewConnectionsHandler(cfg, manager)
	objHandler := handlers.NewObjectsHandler(cfg, manager)
	dataHandler := handlers.NewDataHandler(cfg, manager)
	ddlHandler := handlers.NewDDLHandler(cfg, manager)
	sqlHandler := handlers.NewSQLHandler(cfg, manager)
	linksHandler := handlers.NewLinksHandler(cfg)

	r.Get("/api/health", handlers.Health)

	r.Route("/api/connections", func(r chi.Router) {
		r.Get("/", connHandler.List)
		r.Post("/", connHandler.Create)
		r.Post("/test-config", connHandler.TestConfig)

		r.Route("/{id}", func(r chi.Router) {
			r.Put("/", connHandler.Update)
			r.Put("/visible-schemas", connHandler.UpdateVisibleSchemas)
			r.Delete("/", connHandler.Delete)
			r.Post("/test", connHandler.Test)
			r.Get("/info", connHandler.Info)
			r.Get("/databases", connHandler.Databases)
			r.Post("/duplicate", connHandler.Duplicate)
			r.Get("/objects", objHandler.ListObjects)
			r.Post("/keys", dataHandler.CreateKey)
			r.Get("/objects/{name}/info", objHandler.GetObjectInfo)
			r.Get("/objects/{name}/schema", objHandler.GetSchema)
			r.Get("/objects/{name}/data", dataHandler.GetData)
			r.Post("/mutate", dataHandler.Mutate)
			r.Post("/mutate/bulk", dataHandler.MutateBulk)
			r.Post("/produce", dataHandler.Produce)
			r.Post("/ddl", ddlHandler.Execute)
			r.Post("/execute", sqlHandler.Execute)
			r.Post("/execute-multi", sqlHandler.ExecuteMulti)
			r.Post("/explain", sqlHandler.Explain)
			r.Post("/analyze", sqlHandler.Analyze)
			r.Get("/completions", sqlHandler.Completions)
			r.Get("/sql-catalog", sqlHandler.SQLCatalog)
			r.Get("/history", sqlHandler.History)
			r.Delete("/history", sqlHandler.ClearHistory)
		})
	})

	r.Route("/api/links", func(r chi.Router) {
		r.Get("/", linksHandler.List)
		r.Post("/", linksHandler.Create)
		r.Delete("/{id}", linksHandler.Delete)
		r.Put("/{id}", linksHandler.Update)
	})

	return r
}
