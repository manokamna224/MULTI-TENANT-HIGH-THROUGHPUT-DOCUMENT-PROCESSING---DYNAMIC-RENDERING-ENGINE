// Package validation loads JSON Schemas from embedded FS and validates payloads.
//
// Schema files are embedded at compile time from the schemas/ subdirectory
// next to this file. Each file is named <document_type>.json and is looked up
// by document_type at validation time.
package validation

import (
	"bytes"
	"encoding/json"
	"embed"
	"fmt"

	"github.com/santhosh-tekuri/jsonschema/v5"
)

//go:embed schemas/*.json
var schemaFS embed.FS

// Validator caches compiled JSON Schema objects per document type.
// It is safe for concurrent reads after construction.
type Validator struct {
	schemas map[string]*jsonschema.Schema
}

// New loads and compiles all embedded schemas. Call once at startup.
func New() (*Validator, error) {
	compiler := jsonschema.NewCompiler()
	compiler.ExtractAnnotations = true

	v := &Validator{schemas: make(map[string]*jsonschema.Schema)}

	entries, err := schemaFS.ReadDir("schemas")
	if err != nil {
		return nil, fmt.Errorf("listing embedded schemas: %w", err)
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		fname := entry.Name()
		if len(fname) < 6 || fname[len(fname)-5:] != ".json" {
			continue
		}

		data, err := schemaFS.ReadFile("schemas/" + fname)
		if err != nil {
			return nil, fmt.Errorf("reading schema %s: %w", fname, err)
		}

		docType := fname[:len(fname)-5] // strip ".json"
		memURL  := "mem://schemas/" + fname

		if err := compiler.AddResource(memURL, bytes.NewReader(data)); err != nil {
			return nil, fmt.Errorf("registering schema %s: %w", fname, err)
		}

		compiled, err := compiler.Compile(memURL)
		if err != nil {
			return nil, fmt.Errorf("compiling schema %s: %w", fname, err)
		}
		v.schemas[docType] = compiled
	}

	return v, nil
}

// Validate validates raw JSON payload against the schema for docType.
// Returns nil on success; returns *jsonschema.ValidationError (with full
// instance path detail) on failure so callers can forward structured errors.
func (v *Validator) Validate(docType string, payload []byte) error {
	schema, ok := v.schemas[docType]
	if !ok {
		// Unknown document types are allowed through (no schema = no restriction).
		// Callers that want strict allowlisting should check KnownDocTypes first.
		return nil
	}

	var data interface{}
	if err := json.Unmarshal(payload, &data); err != nil {
		return fmt.Errorf("payload is not valid JSON: %w", err)
	}

	return schema.Validate(data)
}

// KnownDocTypes returns the list of document types that have registered schemas.
func (v *Validator) KnownDocTypes() []string {
	types := make([]string, 0, len(v.schemas))
	for k := range v.schemas {
		types = append(types, k)
	}
	return types
}
