package main

import (
	"bufio"
	"os"
	"strings"
)

// loadDotEnv loads KEY=VALUE pairs from a .env file into the process
// environment, without pulling in a third-party dependency.
//
// It is intentionally minimal: it honours blank lines, "#" comments, an
// optional leading "export ", and single/double-quoted values. Existing
// environment variables are NOT overwritten, so real exported variables
// always win over the file. This mirrors the behaviour expected of a
// development convenience loader; production processes set real env vars.
func loadDotEnv(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")

		key, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		value = unquote(value)

		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		if err := os.Setenv(key, value); err != nil {
			return err
		}
	}
	return scanner.Err()
}

// unquote strips a single matching pair of surrounding single or double
// quotes from a .env value.
func unquote(v string) string {
	if len(v) >= 2 {
		if (v[0] == '"' && v[len(v)-1] == '"') || (v[0] == '\'' && v[len(v)-1] == '\'') {
			return v[1 : len(v)-1]
		}
	}
	return v
}
