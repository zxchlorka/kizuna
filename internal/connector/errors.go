package connector

import "errors"

// ErrBadRequest is returned when request payload is invalid.
var ErrBadRequest = errors.New("bad request")

// ErrConflict is returned when an operation cannot be applied due to state conflict.
var ErrConflict = errors.New("conflict")

// ErrNotFound is returned when a mutate operation targets a row that does not exist.
var ErrNotFound = errors.New("not found")
